import * as v from "valibot";
import { encodeBase64Url } from "../../shared/base64url.ts";
import { AppError } from "../../shared/errors.ts";
import { authorizationOrigin, exchangeResponse, oauthCode, oauthNonce } from "../../shared/github-authorization.ts";

const pendingSlot = "ezshare-github-authorization";
const pendingSchema = v.object({ state: oauthNonce, verifier: oauthNonce, started: v.number() });
const callbackKeys = ["code", "state", "error", "error_description", "error_uri"] as const;

export interface AuthorizationSettings {
    readonly clientId: string;
    readonly brokerOrigin: string;
    readonly repository: string;
}

export interface GitHubAuthorization {
    readonly repository: string;
    readonly start: (signal: AbortSignal) => Promise<void>;
    readonly complete: (signal: AbortSignal) => Promise<string> | null;
}

export function createGitHubAuthorization(settings: AuthorizationSettings): GitHubAuthorization | null {
    const origin = authorizationOrigin(settings.brokerOrigin);
    if (origin === null || !/^[A-Za-z0-9_]{5,128}$/u.test(settings.clientId) || settings.repository === "") {
        return null;
    }
    const redirect = window.location.origin + window.location.pathname;
    return {
        repository: settings.repository,
        start: async (signal) => {
            const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
            const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
            const challenge = encodeBase64Url(
                await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            );
            signal.throwIfAborted();
            sessionStorage.setItem(pendingSlot, JSON.stringify({ state, verifier, started: Date.now() }));
            const url = new URL("https://github.com/login/oauth/authorize");
            url.search = new URLSearchParams({
                client_id: settings.clientId,
                redirect_uri: redirect,
                state,
                code_challenge: challenge,
                code_challenge_method: "S256",
                scope: "offline_access",
            }).toString();
            window.location.assign(url);
        },
        complete: (signal) => {
            const url = new URL(window.location.href);
            if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
                return null;
            }
            return (async () => {
                const code = v.safeParse(oauthCode, url.searchParams.get("code"));
                const state = url.searchParams.get("state");
                const denied = url.searchParams.has("error");
                for (const key of callbackKeys) {
                    url.searchParams.delete(key);
                }
                history.replaceState(history.state, "", url);
                const raw = sessionStorage.getItem(pendingSlot);
                sessionStorage.removeItem(pendingSlot);
                const parsed: unknown = raw === null ? null : JSON.parse(raw);
                const pending = v.safeParse(pendingSchema, parsed);
                if (
                    !pending.success ||
                    pending.output.state !== state ||
                    Date.now() - pending.output.started > 900_000
                ) {
                    throw new AppError("github_authorization_failed");
                }
                if (denied || !code.success) {
                    throw new AppError("github_authorization_failed");
                }
                const response = await fetch(`${origin}/exchange`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code: code.output, verifier: pending.output.verifier }),
                    credentials: "omit",
                    redirect: "error",
                    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                }).catch((cause: unknown) => {
                    if (
                        cause instanceof DOMException &&
                        (cause.name === "AbortError" || cause.name === "TimeoutError")
                    ) {
                        throw cause;
                    }
                    throw new AppError("github_authorization_unavailable", { cause });
                });
                if (!response.ok) {
                    throw new AppError(
                        response.status === 403
                            ? "github_app_not_installed"
                            : response.status >= 500
                              ? "github_authorization_unavailable"
                              : "github_authorization_failed",
                    );
                }
                const body: unknown = await response.json();
                const token = v.safeParse(exchangeResponse, body);
                if (!token.success) {
                    throw new AppError("github_authorization_failed");
                }
                return token.output.token;
            })();
        },
    };
}
