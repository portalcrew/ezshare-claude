import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import sodium from "libsodium-wrappers";

/**
 * A stateful GitHub, reached by the production HTTP client through a loopback server. It keeps users, tokens,
 * runs, artifacts, issues, comments and secrets, and enforces token identities and permissions.
 */

export const ACTIONS_BOT = { id: 41898282, login: "github-actions[bot]", type: "Bot" } as const;

export interface FakeUser {
    readonly id: number;
    readonly login: string;
    readonly type: "User" | "Bot";
}

export interface TokenGrant {
    readonly user: FakeUser;
    readonly secrets: boolean;
    readonly secretWrite?: boolean;
    readonly actions: boolean;
}

export interface FakeRun {
    readonly id: number;
    readonly workflow: string;
    readonly actor: FakeUser;
    readonly displayTitle: string;
    readonly inputs: Readonly<Record<string, string>>;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | null;
    readonly artifacts: string[];
    readonly cancel: AbortController;
}

interface FakeComment {
    readonly id: number;
    body: string;
    readonly user: FakeUser;
}

interface FakeIssue {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly author: FakeUser;
    state: "open" | "closed";
    readonly comments: FakeComment[];
}

export type FakeGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;

export async function startFakeGitHub(options: {
    readonly repository: string;
    readonly isPrivate?: boolean;
    readonly branchProtected?: boolean;
}) {
    await sodium.ready;
    const secretKeys = sodium.crypto_box_keypair();
    const tokens = new Map<string, TokenGrant>();
    const runs: FakeRun[] = [];
    const issues: FakeIssue[] = [];
    const secrets = new Map<string, string>();
    const dispatchListeners: ((run: FakeRun) => void)[] = [];
    let nextId = 7000;
    let available = true;

    const respond = (request: IncomingMessage, response: ServerResponse, status: number, value?: unknown) => {
        const body = value === undefined ? "" : JSON.stringify(value);
        const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 24)}"`;
        if (request.method === "GET" && status === 200 && request.headers["if-none-match"] === etag) {
            response.writeHead(304, { etag }).end();
            return;
        }
        response
            .writeHead(status, { "content-type": "application/json", ...(status === 200 ? { etag } : {}) })
            .end(body);
    };

    const readBody = async (request: IncomingMessage): Promise<unknown> => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return text.length === 0 ? {} : JSON.parse(text);
    };

    const toRun = (run: FakeRun) => ({
        id: run.id,
        path: `.github/workflows/${run.workflow}@refs/heads/main`,
        event: "workflow_dispatch",
        head_branch: "main",
        display_title: run.displayTitle,
        status: run.status,
        conclusion: run.conclusion,
        run_attempt: 1,
        actor: { id: run.actor.id, login: run.actor.login },
        triggering_actor: { id: run.actor.id, login: run.actor.login },
    });

    const server = createServer(async (request, response) => {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH");
        response.setHeader(
            "access-control-allow-headers",
            "authorization, accept, content-type, if-none-match, x-github-api-version",
        );
        response.setHeader("access-control-expose-headers", "etag, x-ratelimit-remaining");
        if (request.method === "OPTIONS") {
            response.writeHead(204).end();
            return;
        }
        if (!available) {
            respond(request, response, 503, { message: "unavailable" });
            return;
        }
        const grant = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
        if (grant === undefined) {
            respond(request, response, 401, { message: "Bad credentials" });
            return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        const path = url.pathname;
        const repo = `/repos/${options.repository}`;
        const body = await readBody(request);
        const field = (name: string): unknown =>
            typeof body === "object" && body !== null && name in body ? Reflect.get(body, name) : undefined;

        if (path === "/user") {
            respond(request, response, 200, { id: grant.user.id, login: grant.user.login });
            return;
        }
        if (!path.startsWith(repo)) {
            respond(request, response, 404, { message: "Not Found" });
            return;
        }
        const rest = path.slice(repo.length);
        const segment = (pattern: RegExp, method?: string): string | undefined =>
            method === undefined || request.method === method ? pattern.exec(rest)?.[1] : undefined;
        const workflowRuns = segment(/^\/actions\/workflows\/([a-z]+\.yml)\/runs$/u);
        const runPath = segment(/^\/actions\/runs\/(\d+)$/u);
        const artifactsPath = segment(/^\/actions\/runs\/(\d+)\/artifacts$/u);
        const cancelPath = segment(/^\/actions\/runs\/(\d+)\/cancel$/u, "POST");
        const dispatchPath = segment(/^\/actions\/workflows\/([a-z]+\.yml)\/dispatches$/u, "POST");
        const issuePath = segment(/^\/issues\/(\d+)$/u);
        const commentsPath = segment(/^\/issues\/(\d+)\/comments$/u);
        const secretPath = segment(/^\/actions\/secrets\/([A-Z_]+)$/u, "PUT");
        if (rest === "") {
            respond(request, response, 200, {
                full_name: options.repository,
                private: options.isPrivate ?? false,
                default_branch: "main",
            });
        } else if (rest === "/branches/main") {
            respond(request, response, 200, { name: "main", protected: options.branchProtected ?? true });
        } else if (rest === "/actions/runs" || workflowRuns !== undefined) {
            const workflow = workflowRuns ?? null;
            const status = url.searchParams.get("status");
            const found = runs
                .filter((run) => run.actor.login === url.searchParams.get("actor"))
                .filter((run) => workflow === null || run.workflow === workflow)
                .filter((run) => status === null || run.status === status)
                .reverse();
            respond(request, response, 200, { total_count: found.length, workflow_runs: found.map(toRun) });
        } else if (runPath !== undefined) {
            const run = runs.find((candidate) => candidate.id === Number(runPath));
            respond(request, response, run === undefined ? 404 : 200, run === undefined ? {} : toRun(run));
        } else if (artifactsPath !== undefined) {
            const run = runs.find((candidate) => candidate.id === Number(artifactsPath));
            respond(request, response, 200, {
                total_count: run?.artifacts.length ?? 0,
                artifacts: (run?.artifacts ?? []).map((name) => ({ name, workflow_run: { id: run?.id } })),
            });
        } else if (cancelPath !== undefined) {
            const run = runs.find((candidate) => candidate.id === Number(cancelPath));
            if (!grant.actions || run === undefined) {
                respond(request, response, 403, {});
                return;
            }
            if (run.status === "completed") {
                respond(request, response, 409, {});
                return;
            }
            run.cancel.abort(new DOMException("Run cancelled", "AbortError"));
            run.status = "completed";
            run.conclusion = "cancelled";
            respond(request, response, 202, {});
        } else if (dispatchPath !== undefined) {
            const workflow = dispatchPath;
            const inputs = field("inputs");
            if (!grant.actions || field("ref") !== "main" || typeof inputs !== "object" || inputs === null) {
                respond(request, response, grant.actions ? 422 : 403, {});
                return;
            }
            const values = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value)]));
            const run: FakeRun = {
                id: ++nextId,
                workflow,
                actor: grant.user,
                displayTitle: `ezshare-${grant.user.id}-${values["request_id"] ?? ""}`,
                inputs: values,
                status: "queued",
                conclusion: null,
                artifacts: [],
                cancel: new AbortController(),
            };
            runs.push(run);
            respond(request, response, 204);
            for (const listener of dispatchListeners) {
                listener(run);
            }
        } else if (rest === "/issues" && request.method === "POST") {
            const issue: FakeIssue = {
                number: ++nextId,
                title: String(field("title")),
                body: String(field("body")),
                author: grant.user,
                state: "open",
                comments: [],
            };
            issues.push(issue);
            respond(request, response, 201, {
                number: issue.number,
                title: issue.title,
                state: "open",
                user: grant.user,
            });
        } else if (issuePath !== undefined) {
            const issue = issues.find((candidate) => candidate.number === Number(issuePath));
            if (issue === undefined) {
                respond(request, response, 404, {});
                return;
            }
            if (request.method === "PATCH") {
                issue.state = field("state") === "closed" ? "closed" : issue.state;
            }
            respond(request, response, 200, {
                number: issue.number,
                title: issue.title,
                state: issue.state,
                user: { id: issue.author.id, type: issue.author.type },
            });
        } else if (commentsPath !== undefined) {
            const issue = issues.find((candidate) => candidate.number === Number(commentsPath));
            if (issue === undefined) {
                respond(request, response, 404, {});
                return;
            }
            if (request.method === "POST") {
                issue.comments.push({ id: ++nextId, body: String(field("body")), user: grant.user });
                respond(request, response, 201, {});
                return;
            }
            const page = Number(url.searchParams.get("page") ?? "1");
            const size = Number(url.searchParams.get("per_page") ?? "30");
            respond(
                request,
                response,
                200,
                issue.comments.slice((page - 1) * size, page * size).map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    user: { id: comment.user.id, type: comment.user.type },
                })),
            );
        } else if (rest === "/actions/secrets/public-key") {
            respond(
                request,
                response,
                grant.secrets ? 200 : 403,
                grant.secrets
                    ? {
                          key_id: "fake-key-1",
                          key: sodium.to_base64(secretKeys.publicKey, sodium.base64_variants.ORIGINAL),
                      }
                    : {},
            );
        } else if (secretPath !== undefined) {
            if (!grant.secrets || grant.secretWrite === false || field("key_id") !== "fake-key-1") {
                respond(request, response, 403, {});
                return;
            }
            secrets.set(secretPath, String(field("encrypted_value")));
            respond(request, response, 201);
        } else {
            respond(request, response, 404, { message: `No fake for ${request.method} ${path}` });
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
    }

    return {
        origin: `http://127.0.0.1:${address.port}`,
        runs,
        issues,
        grant: (token: string, grant: TokenGrant) => tokens.set(token, grant),
        revoke: (token: string) => tokens.delete(token),
        setAvailable: (value: boolean) => {
            available = value;
        },
        onDispatch: (listener: (run: FakeRun) => void) => dispatchListeners.push(listener),
        /** Decrypts a stored repository secret the way GitHub Actions would. */
        secret: (name: string): string | null => {
            const sealed = secrets.get(name);
            return sealed === undefined
                ? null
                : sodium.to_string(
                      sodium.crypto_box_seal_open(
                          sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
                          secretKeys.publicKey,
                          secretKeys.privateKey,
                      ),
                  );
        },
        close: async () => {
            server.closeAllConnections();
            server.close();
            await once(server, "close");
        },
    };
}
