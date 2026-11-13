import { decodeBase64, encodeBase64 } from "../../shared/base64url.ts";
import { AppError, throwIfCancelled } from "../../shared/errors.ts";

/** Encrypts a value for GitHub's repository secrets API with the repository's sealed-box public key. */
export async function sealForGitHub(publicKey: string, value: string, signal: AbortSignal): Promise<string> {
    const key = decodeBase64(publicKey);
    if (key.length !== 32) {
        throw new AppError("invalid_response");
    }
    const { default: sodium } = await import("libsodium-wrappers");
    await sodium.ready;
    throwIfCancelled(signal);
    return encodeBase64(sodium.crypto_box_seal(new TextEncoder().encode(value), key));
}
