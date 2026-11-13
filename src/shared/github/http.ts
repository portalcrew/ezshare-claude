import { withDeadline } from "../async.ts";
import { type AccessDeniedCode, AppError, throwIfCancelled } from "../errors.ts";
import { parseJson } from "../protocol.ts";

export const GITHUB_API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4_000_000;

/** Only the public API, or a loopback server for a local stateful fake, may receive a token. */
export function apiOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch (cause) {
        throw new AppError("invalid_input", { cause });
    }
    const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
        (!loopback && url.origin !== GITHUB_API_ORIGIN) ||
        !["", "/"].includes(url.pathname) ||
        url.search !== "" ||
        url.hash !== "" ||
        url.username !== "" ||
        url.password !== ""
    ) {
        throw new AppError("invalid_input");
    }
    return url.origin;
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

/**
 * GitHub REST transport. Reads are conditional on the last ETag so unchanged polls are answered with 304,
 * which GitHub does not count against the shared rate limit.
 */
export class GitHubHttp {
    readonly #origin: string;
    readonly #token: string;
    readonly #validators = new Map<string, { readonly etag: string; readonly value: unknown }>();

    constructor(token: string, origin: string = GITHUB_API_ORIGIN) {
        const trimmed = token.trim();
        if (trimmed.length === 0 || trimmed.length > 512 || !/^[\x21-\x7e]+$/u.test(trimmed)) {
            throw new AppError("invalid_input");
        }
        this.#token = trimmed;
        this.#origin = apiOrigin(origin);
    }

    readonly get = (path: string, signal: AbortSignal, denial: AccessDeniedCode): Promise<unknown> =>
        this.#request("GET", path, undefined, signal, denial);

    readonly post = (
        path: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
        denial: AccessDeniedCode,
    ): Promise<unknown> => this.#request("POST", path, body, signal, denial);

    readonly put = (
        path: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
        denial: AccessDeniedCode,
    ): Promise<unknown> => this.#request("PUT", path, body, signal, denial);

    readonly patch = (
        path: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
        denial: AccessDeniedCode,
    ): Promise<unknown> => this.#request("PATCH", path, body, signal, denial);

    readonly #request = async (
        method: Method,
        path: string,
        body: Readonly<Record<string, unknown>> | undefined,
        signal: AbortSignal,
        denial: AccessDeniedCode,
    ): Promise<unknown> => {
        throwIfCancelled(signal);
        if (!path.startsWith("/") || path.startsWith("//")) {
            throw new AppError("invalid_input");
        }
        const url = new URL(path, this.#origin).href;
        const cached = method === "GET" ? this.#validators.get(url) : undefined;
        try {
            return await withDeadline(REQUEST_TIMEOUT_MS, signal, async (bounded) => {
                const response = await fetch(url, {
                    method,
                    cache: "no-store",
                    redirect: "error",
                    credentials: "omit",
                    referrerPolicy: "no-referrer",
                    signal: bounded,
                    headers: {
                        accept: "application/vnd.github+json",
                        authorization: `Bearer ${this.#token}`,
                        "x-github-api-version": "2022-11-28",
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                        ...(cached === undefined ? {} : { "if-none-match": cached.etag }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                if (response.status === 304 && cached !== undefined) {
                    await response.body?.cancel();
                    return cached.value;
                }
                if (!response.ok) {
                    await response.body?.cancel();
                    throw failure(response, denial);
                }
                if (response.status === 201 || response.status === 202 || response.status === 204) {
                    const text = await readBounded(response);
                    return text.length === 0 ? null : parseJson(text);
                }
                const value = parseJson(await readBounded(response));
                const etag = response.headers.get("etag");
                if (method === "GET" && etag !== null) {
                    this.#validators.set(url, { etag, value });
                }
                return value;
            });
        } catch (cause) {
            if (cause instanceof AppError) {
                throw cause;
            }
            throw new AppError("github_unavailable", { cause });
        }
    };
}

function failure(response: Response, denial: AccessDeniedCode): AppError {
    switch (response.status) {
        case 401:
            return new AppError("unauthenticated");
        case 403:
            return response.headers.get("x-ratelimit-remaining") === "0"
                ? new AppError("rate_limited")
                : new AppError(denial);
        case 404:
            return new AppError("not_found");
        case 409:
        case 422:
            return new AppError("conflict");
        case 429:
            return new AppError("rate_limited");
        default:
            return new AppError("github_unavailable");
    }
}

async function readBounded(response: Response): Promise<string> {
    if (response.body === null) {
        return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new AppError("invalid_response");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}
