import * as v from "valibot";

export const oauthNonce = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
export const oauthCode = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,512}$/u));
export const appUserToken = v.pipe(v.string(), v.regex(/^ghu_[A-Za-z0-9_]{20,250}$/u));
export const exchangeRequest = v.strictObject({ code: oauthCode, verifier: oauthNonce });
export const exchangeResponse = v.object({ token: appUserToken });

export function authorizationOrigin(value: unknown): string | null {
    if (typeof value !== "string" || value === "") {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value ? url.origin : null;
    } catch {
        return null;
    }
}
