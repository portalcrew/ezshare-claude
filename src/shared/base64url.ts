import { AppError } from "./errors.ts";

const ALPHABET = /^[A-Za-z0-9_-]*$/u;

export function encodeBase64Url(bytes: Uint8Array | ArrayBuffer): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const byte of view) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decodes canonical unpadded base64url; any other spelling of the same bytes is rejected. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
    if (!ALPHABET.test(value) || value.length % 4 === 1) {
        throw new AppError("invalid_response");
    }
    const padded = value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    let binary: string;
    try {
        binary = atob(padded);
    } catch (cause) {
        throw new AppError("invalid_response", { cause });
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) {
        throw new AppError("invalid_response");
    }
    return bytes;
}

/** Standard padded base64, as GitHub's secrets API requires. */
export function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
    try {
        const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
        if (encodeBase64(bytes) !== value) {
            throw new AppError("invalid_response");
        }
        return bytes;
    } catch (cause) {
        throw cause instanceof AppError ? cause : new AppError("invalid_response", { cause });
    }
}
