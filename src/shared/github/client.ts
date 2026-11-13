import * as v from "valibot";
import { AppError } from "../errors.ts";
import { type DispatchInputs, type Purpose, runNamePrefix, workflowPath } from "../protocol.ts";
import { GitHubHttp } from "./http.ts";

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

const identifier = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const shortText = v.pipe(v.string(), v.maxLength(1024));
const loginSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(39), v.regex(/^[A-Za-z0-9-]+$/u));
const actorSchema = v.object({ id: identifier, type: v.optional(shortText) });

const userSchema = v.object({ id: identifier, login: loginSchema });
const repositorySchema = v.object({
    full_name: shortText,
    private: v.boolean(),
    default_branch: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});
const branchSchema = v.object({ protected: v.boolean() });
const runSchema = v.object({
    id: identifier,
    path: shortText,
    event: shortText,
    head_branch: v.nullable(shortText),
    display_title: shortText,
    status: v.nullable(shortText),
    conclusion: v.nullable(shortText),
    run_attempt: v.optional(identifier),
    actor: v.nullable(actorSchema),
    triggering_actor: v.optional(v.nullable(actorSchema)),
});
const runsSchema = v.object({
    total_count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    workflow_runs: v.pipe(v.array(runSchema), v.maxLength(PAGE_SIZE)),
});
const artifactsSchema = v.object({
    artifacts: v.pipe(
        v.array(v.object({ name: shortText, workflow_run: v.nullable(v.object({ id: v.optional(identifier) })) })),
        v.maxLength(PAGE_SIZE),
    ),
});
const issueSchema = v.object({
    number: identifier,
    title: shortText,
    state: shortText,
    user: v.nullable(actorSchema),
    pull_request: v.optional(v.unknown()),
});
const commentSchema = v.object({
    id: identifier,
    body: v.pipe(v.string(), v.maxLength(65_536)),
    user: v.nullable(v.object({ id: identifier, type: shortText })),
});
const secretKeySchema = v.object({
    key_id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    key: v.pipe(v.string(), v.maxLength(128)),
});

export interface GitHubUser {
    readonly id: string;
    readonly login: string;
}

export interface Repository {
    readonly name: string;
    readonly isPrivate: boolean;
    readonly defaultBranch: string;
}

export interface WorkflowRun {
    readonly id: string;
    readonly path: string;
    readonly event: string;
    readonly headBranch: string | null;
    readonly displayTitle: string;
    readonly status: string | null;
    readonly conclusion: string | null;
    readonly attempt: number;
    readonly actorId: string | null;
    readonly triggeringActorId: string | null;
}

export interface IssueComment {
    readonly id: number;
    readonly body: string;
    readonly author: { readonly id: string; readonly type: string } | null;
}

/** Validates an `owner/name` repository and returns its canonical lowercase spelling. */
export function repositoryName(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/u.test(normalized)) {
        throw new AppError("invalid_input");
    }
    const name = normalized.slice(normalized.indexOf("/") + 1);
    if (name === "." || name === "..") {
        throw new AppError("invalid_input");
    }
    return normalized;
}

function decode<const TSchema extends v.GenericSchema>(schema: TSchema, value: unknown): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value);
    if (!parsed.success) {
        throw new AppError("invalid_response");
    }
    return parsed.output;
}

function toRun(run: v.InferOutput<typeof runSchema>): WorkflowRun {
    return {
        id: String(run.id),
        path: run.path.split("@")[0] ?? "",
        event: run.event,
        headBranch: run.head_branch,
        displayTitle: run.display_title,
        status: run.status,
        conclusion: run.conclusion,
        attempt: run.run_attempt ?? 1,
        actorId: run.actor === null ? null : String(run.actor.id),
        triggeringActorId:
            run.triggering_actor === undefined || run.triggering_actor === null
                ? null
                : String(run.triggering_actor.id),
    };
}

/** The GitHub operations ezshare-claude performs. Every path is built from validated values only. */
export class GitHubClient {
    readonly #http: GitHubHttp;

    constructor(token: string, origin?: string) {
        this.#http = new GitHubHttp(token, origin);
    }

    readonly user = async (signal: AbortSignal): Promise<GitHubUser> => {
        const user = decode(userSchema, await this.#http.get("/user", signal, "forbidden"));
        return { id: String(user.id), login: user.login };
    };

    readonly repository = async (repository: string, signal: AbortSignal): Promise<Repository> => {
        const name = repositoryName(repository);
        const found = decode(repositorySchema, await this.#http.get(`/repos/${name}`, signal, "forbidden"));
        if (found.full_name.toLowerCase() !== name) {
            throw new AppError("invalid_response");
        }
        return { name, isPrivate: found.private, defaultBranch: found.default_branch };
    };

    readonly branchProtected = async (repository: Repository, signal: AbortSignal): Promise<boolean> => {
        const branch = encodeURIComponent(repository.defaultBranch);
        return decode(
            branchSchema,
            await this.#http.get(`/repos/${repository.name}/branches/${branch}`, signal, "contents_read_forbidden"),
        ).protected;
    };

    /** Every unfinished session run the member dispatched in the repository. */
    readonly activeSessions = async (
        repository: string,
        user: GitHubUser,
        signal: AbortSignal,
    ): Promise<readonly WorkflowRun[]> => {
        const name = repositoryName(repository);
        const found = new Map<string, WorkflowRun>();
        for (const status of ["queued", "in_progress", "waiting", "pending", "requested"] as const) {
            for (let page = 1; page <= MAX_PAGES; page++) {
                const query = new URLSearchParams({
                    actor: user.login,
                    event: "workflow_dispatch",
                    status,
                    per_page: String(PAGE_SIZE),
                    page: String(page),
                });
                const runs = decode(
                    runsSchema,
                    await this.#http.get(`/repos/${name}/actions/runs?${query}`, signal, "actions_read_forbidden"),
                );
                for (const run of runs.workflow_runs.map(toRun)) {
                    if (
                        run.actorId === user.id &&
                        run.displayTitle.startsWith(runNamePrefix(user.id)) &&
                        (run.path === workflowPath("chat") || run.path === workflowPath("login"))
                    ) {
                        found.set(run.id, run);
                    }
                }
                if (page * PAGE_SIZE >= runs.total_count) {
                    break;
                }
                if (page === MAX_PAGES) {
                    throw new AppError("invalid_response");
                }
            }
        }
        return [...found.values()];
    };

    /** The member's most recent runs of one session workflow, finished or not. */
    readonly recentSessionRuns = async (
        repository: string,
        user: GitHubUser,
        purpose: Purpose,
        signal: AbortSignal,
    ): Promise<readonly WorkflowRun[]> => {
        const name = repositoryName(repository);
        const query = new URLSearchParams({ actor: user.login, event: "workflow_dispatch", per_page: "30" });
        const runs = decode(
            runsSchema,
            await this.#http.get(
                `/repos/${name}/actions/workflows/${purpose}.yml/runs?${query}`,
                signal,
                "actions_read_forbidden",
            ),
        );
        return runs.workflow_runs
            .map(toRun)
            .filter((run) => run.actorId === user.id && run.path === workflowPath(purpose));
    };

    readonly run = async (repository: string, runId: string, signal: AbortSignal): Promise<WorkflowRun> => {
        const name = repositoryName(repository);
        if (!/^[1-9][0-9]{0,18}$/u.test(runId)) {
            throw new AppError("invalid_input");
        }
        return toRun(
            decode(
                runSchema,
                await this.#http.get(`/repos/${name}/actions/runs/${runId}`, signal, "actions_read_forbidden"),
            ),
        );
    };

    readonly runArtifactNames = async (
        repository: string,
        runId: string,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const name = repositoryName(repository);
        const found = decode(
            artifactsSchema,
            await this.#http.get(
                `/repos/${name}/actions/runs/${runId}/artifacts?per_page=${PAGE_SIZE}`,
                signal,
                "actions_read_forbidden",
            ),
        );
        return found.artifacts
            .filter((artifact) => artifact.workflow_run === null || artifact.workflow_run.id === Number(runId))
            .map((artifact) => artifact.name);
    };

    readonly dispatch = async (
        repository: Repository,
        purpose: Purpose,
        inputs: DispatchInputs,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#http.post(
            `/repos/${repository.name}/actions/workflows/${purpose}.yml/dispatches`,
            { ref: repository.defaultBranch, inputs: { ...inputs } },
            signal,
            "actions_write_forbidden",
        );
    };

    readonly cancelRun = async (repository: string, runId: string, signal: AbortSignal): Promise<void> => {
        const name = repositoryName(repository);
        if (!/^[1-9][0-9]{0,18}$/u.test(runId)) {
            throw new AppError("invalid_input");
        }
        await this.#http.post(`/repos/${name}/actions/runs/${runId}/cancel`, {}, signal, "actions_write_forbidden");
    };

    readonly createIssue = async (
        repository: string,
        title: string,
        body: string,
        signal: AbortSignal,
    ): Promise<number> => {
        const name = repositoryName(repository);
        return decode(
            issueSchema,
            await this.#http.post(`/repos/${name}/issues`, { title, body }, signal, "issues_write_forbidden"),
        ).number;
    };

    readonly issue = async (repository: string, issue: number, signal: AbortSignal) => {
        const name = repositoryName(repository);
        const found = decode(
            issueSchema,
            await this.#http.get(`/repos/${name}/issues/${issue}`, signal, "issues_read_forbidden"),
        );
        return {
            title: found.title,
            state: found.state,
            authorId: found.user === null ? null : String(found.user.id),
            isPullRequest: found.pull_request !== undefined,
        };
    };

    readonly comments = async (
        repository: string,
        issue: number,
        signal: AbortSignal,
    ): Promise<readonly IssueComment[]> => {
        const name = repositoryName(repository);
        const comments: IssueComment[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const batch = decode(
                v.pipe(v.array(commentSchema), v.maxLength(PAGE_SIZE)),
                await this.#http.get(
                    `/repos/${name}/issues/${issue}/comments?per_page=${PAGE_SIZE}&page=${page}`,
                    signal,
                    "issues_read_forbidden",
                ),
            );
            comments.push(
                ...batch.map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    author: comment.user === null ? null : { id: String(comment.user.id), type: comment.user.type },
                })),
            );
            if (batch.length < PAGE_SIZE) {
                return comments;
            }
        }
        throw new AppError("invalid_response");
    };

    readonly comment = async (repository: string, issue: number, body: string, signal: AbortSignal) => {
        const name = repositoryName(repository);
        await this.#http.post(`/repos/${name}/issues/${issue}/comments`, { body }, signal, "issues_write_forbidden");
    };

    readonly closeIssue = async (repository: string, issue: number, signal: AbortSignal): Promise<void> => {
        const name = repositoryName(repository);
        await this.#http.patch(
            `/repos/${name}/issues/${issue}`,
            { state: "closed", state_reason: "completed" },
            signal,
            "issues_write_forbidden",
        );
    };

    readonly secretPublicKey = async (repository: string, signal: AbortSignal) => {
        const name = repositoryName(repository);
        const key = decode(
            secretKeySchema,
            await this.#http.get(`/repos/${name}/actions/secrets/public-key`, signal, "secrets_read_forbidden"),
        );
        return { keyId: key.key_id, key: key.key };
    };

    readonly putSecret = async (
        repository: string,
        secret: string,
        keyId: string,
        encryptedValue: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const name = repositoryName(repository);
        if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(secret)) {
            throw new AppError("invalid_input");
        }
        await this.#http.put(
            `/repos/${name}/actions/secrets/${secret}`,
            { key_id: keyId, encrypted_value: encryptedValue },
            signal,
            "secrets_write_forbidden",
        );
    };
}
