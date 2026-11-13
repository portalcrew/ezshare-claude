import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";
import { AppError } from "./errors.ts";
import { bindingText, type ChannelBinding, type EnvelopeHeader, headerText, type Sender } from "./protocol.ts";

/**
 * Session channel cryptography.
 *
 * Each side holds an X25519 key whose public half reaches the peer through a path the other members cannot
 * write: the browser's key is a workflow_dispatch input fixed by the member's own token, and the runner's key
 * is the name of an artifact only that run can upload. An X25519 agreement between the two keys, expanded with
 * HKDF per direction and bound to the session, yields AES-GCM keys. A message that decrypts was therefore
 * written by one of the two endpoints, never by another member who can merely post as the Actions bot.
 */

const X25519 = { name: "X25519" } as const;

export interface ChannelKey {
    readonly publicKey: string;
    readonly privateKey: CryptoKey;
}

export interface ChannelKeys {
    readonly send: CryptoKey;
    readonly receive: CryptoKey;
}

export async function createChannelKey(): Promise<ChannelKey> {
    const pair = await crypto.subtle.generateKey(X25519, false, ["deriveBits"]);
    if (!("privateKey" in pair)) {
        throw new AppError("unexpected");
    }
    return {
        publicKey: encodeBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
        privateKey: pair.privateKey,
    };
}

/** A key whose private half can be written to a file for the next workflow step. */
export async function createPortableChannelKey(): Promise<{ readonly publicKey: string; readonly pkcs8: Uint8Array }> {
    const pair = await crypto.subtle.generateKey(X25519, true, ["deriveBits"]);
    if (!("privateKey" in pair)) {
        throw new AppError("unexpected");
    }
    return {
        publicKey: encodeBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
        pkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    };
}

/** Imports a portable key as non-extractable and proves it matches the published public key. */
export async function importChannelKey(pkcs8: Uint8Array<ArrayBuffer>, publicKey: string): Promise<ChannelKey> {
    try {
        const portable = await crypto.subtle.importKey("pkcs8", pkcs8, X25519, true, ["deriveBits"]);
        const jwk = await crypto.subtle.exportKey("jwk", portable);
        if (jwk.x !== publicKey) {
            throw new AppError("unsafe_execution");
        }
        const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, X25519, false, ["deriveBits"]);
        return { publicKey, privateKey };
    } catch (cause) {
        throw cause instanceof AppError ? cause : new AppError("unsafe_execution", { cause });
    } finally {
        pkcs8.fill(0);
    }
}

/** Derives this side's send and receive keys for one session. */
export async function deriveChannelKeys(
    own: ChannelKey,
    peerPublicKey: string,
    binding: ChannelBinding,
    self: Sender,
): Promise<ChannelKeys> {
    try {
        const peer = await crypto.subtle.importKey("raw", decodeBase64Url(peerPublicKey), X25519, false, []);
        const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, own.privateKey, 256);
        const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
        const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", encode(bindingText(binding))));
        const direction = async (sender: Sender, usages: KeyUsage[]) =>
            crypto.subtle.deriveKey(
                { name: "HKDF", hash: "SHA-256", salt, info: encode(`ezshare/v1/${sender}`) },
                material,
                { name: "AES-GCM", length: 256 },
                false,
                usages,
            );
        const peerSender: Sender = self === "browser" ? "runner" : "browser";
        // The own direction also decrypts, so a reloaded browser can find its earlier sequence numbers.
        return {
            send: await direction(self, ["encrypt", "decrypt"]),
            receive: await direction(peerSender, ["decrypt"]),
        };
    } catch (cause) {
        throw new AppError("unsafe_execution", { cause });
    }
}

export async function seal(
    key: CryptoKey,
    header: EnvelopeHeader,
    body: unknown,
): Promise<{ readonly nonce: string; readonly data: string }> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encode(headerText(header)) },
        key,
        encode(JSON.stringify(body)),
    );
    return { nonce: encodeBase64Url(nonce), data: encodeBase64Url(data) };
}

/** Returns the decrypted text, or `null` when the message was not written by the peer of this channel. */
export async function open(
    key: CryptoKey,
    header: EnvelopeHeader,
    sealed: { readonly nonce: string; readonly data: string },
): Promise<string | null> {
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: decodeBase64Url(sealed.nonce), additionalData: encode(headerText(header)) },
            key,
            decodeBase64Url(sealed.data),
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } catch {
        return null;
    }
}

function encode(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}
