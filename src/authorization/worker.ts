import * as v from "valibot";
import { appUserToken, exchangeRequest } from "../shared/github-authorization.ts";

interface Env {
    readonly GITHUB_APP_CLIENT_ID?: string;
    readonly GITHUB_APP_CLIENT_SECRET?: string;
    readonly LAUNCHER_URL: string;
    readonly REPOSITORY: string;
    readonly REPOSITORY_ID: string;
}

const upstreamToken = v.object({ access_token: appUserToken, expires_in: v.pipe(v.number(), v.minValue(1)) });

function reply(status: number, origin?: string, body?: object): Response {
    const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" });
    if (origin !== undefined) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
    }
    if (body === undefined) {
        return new Response(null, { status, headers });
    }
    return Response.json(body, { status, headers });
}

async function exchange(request: Request, env: Env, origin: string): Promise<Response> {
    const clientId = env.GITHUB_APP_CLIENT_ID;
    const secret = env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !secret) {
        return reply(503, origin);
    }
    const body = request.body?.getReader();
    if (body === undefined || request.headers.get("Content-Type") !== "application/json") {
        await body?.cancel();
        return reply(400, origin);
    }
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const cancel = () => void body.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
        while (true) {
            const chunk = await body.read();
            if (chunk.done) {
                break;
            }
            size += chunk.value.byteLength;
            if (size > 1_024) {
                await body.cancel();
                return reply(413, origin);
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        signal.removeEventListener("abort", cancel);
        body.releaseLock();
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(text + decoder.decode());
    } catch {
        return reply(400, origin);
    }
    const input = v.safeParse(exchangeRequest, decoded);
    if (!input.success) {
        return reply(400, origin);
    }
    const upstream = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { Accept: "application/json" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: secret,
            code: input.output.code,
            code_verifier: input.output.verifier,
            redirect_uri: env.LAUNCHER_URL,
            repository_id: env.REPOSITORY_ID,
        }),
    });
    if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply(upstream.status >= 500 || upstream.status === 429 ? 503 : 401, origin);
    }
    const value: unknown = await upstream.json();
    const token = v.safeParse(upstreamToken, value);
    if (!token.success) {
        return reply(401, origin);
    }
    // Unlike public repository metadata, listing Actions Secrets requires a repository grant.
    // GitHub can ignore an inaccessible repository_id during exchange; never release that token.
    if (!/^[\w.-]+\/[\w.-]+$/u.test(env.REPOSITORY)) {
        return reply(503, origin);
    }
    const granted = await fetch(`https://api.github.com/repos/${env.REPOSITORY}/actions/secrets?per_page=1`, {
        redirect: "error",
        signal,
        headers: {
            Authorization: `Bearer ${token.output.access_token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ezshare-claude-authorization",
        },
    });
    await granted.body?.cancel();
    if (!granted.ok) {
        return reply(granted.status >= 500 || granted.status === 429 ? 503 : 403, origin);
    }
    return reply(200, origin, { token: token.output.access_token });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/health" && request.method === "GET") {
            return reply(200, undefined, {
                configured: Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET),
            });
        }
        if (path !== "/exchange") {
            return reply(404);
        }
        const origin = new URL(env.LAUNCHER_URL).origin;
        if (request.headers.get("Origin") !== origin) {
            return reply(403);
        }
        if (request.method === "OPTIONS") {
            return reply(204, origin);
        }
        if (request.method !== "POST") {
            return reply(405, origin);
        }
        try {
            return await exchange(request, env, origin);
        } catch {
            return reply(503, origin);
        }
    },
};
