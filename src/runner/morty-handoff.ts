import { createDecipheriv, hkdfSync } from "node:crypto";
import * as v from "valibot";
import { withDeadline } from "../shared/async.ts";
import { AppError } from "../shared/errors.ts";
import { mortyUrl, parseJson, requestIdSchema } from "../shared/protocol.ts";

const sealedResponse = v.object({ sealed: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,32768}$/u)) });
const handoffTarget = v.object({
    version: v.literal(1),
    harness: v.literal("claude"),
    sessionId: requestIdSchema,
    workspace: v.string(),
});

/** Verify the sealed-v1 target without redeeming the link or handing the relay its decryption key. */
export async function verifyMortyHandoff(
    ready: { readonly url: string; readonly computerId: string; readonly workspace: string },
    expected: { readonly sessionId: string; readonly workspace: string },
    relayOrigin: string,
    signal: AbortSignal,
): Promise<string> {
    const url = new URL(mortyUrl(ready.url));
    const tag = url.hash.slice(3);
    const separator = tag.lastIndexOf(".");
    const computerId = tag.slice(0, separator);
    const secret = Buffer.from(tag.slice(separator + 1), "base64url");
    if (computerId !== ready.computerId || ready.workspace !== expected.workspace || secret.length !== 16) {
        throw new AppError("invalid_response");
    }
    // Morty sealed-v1 separates the public lookup ID and the AES key using HKDF.
    const derive = (purpose: "lookup" | "key", length: number) =>
        Buffer.from(hkdfSync("sha256", secret, "", `morty setup handoff v1 ${purpose}`, length));
    const lookupId = derive("lookup", 16).toString("base64url");
    const endpoint = new URL(
        `/morty/api/v1/computers/${encodeURIComponent(computerId)}/identity/setup-handoffs/${lookupId}`,
        relayOrigin,
    );
    const { sealed } = await withDeadline(10_000, signal, async (bounded) => {
        const response = await fetch(endpoint, { signal: bounded, redirect: "error" });
        if (!response.ok) {
            await response.body?.cancel();
            throw new AppError("invalid_response");
        }
        return v.parse(sealedResponse, await response.json());
    });
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length <= 28) {
        throw new AppError("invalid_response");
    }
    const decipher = createDecipheriv("aes-256-gcm", derive("key", 32), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`morty setup handoff v1\0${computerId}`));
    decipher.setAuthTag(bytes.subarray(-16));
    const payload = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    const target = v.parse(handoffTarget, parseJson(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
    if (target.sessionId !== expected.sessionId || target.workspace !== expected.workspace) {
        throw new AppError("invalid_response");
    }
    return url.href;
}
