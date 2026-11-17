import { accountName, LEGACY_ACCOUNT } from "../../shared/accounts.ts";
import type { Clock } from "../../shared/async.ts";
import { type MessageSchema, SessionChannel } from "../../shared/channel.ts";
import { type ChannelKey, createChannelKey, deriveChannelKeys } from "../../shared/channel-crypto.ts";
import { AppError, isAccessDenied, toAppError } from "../../shared/errors.ts";
import type { GitHubClient, GitHubUser, Repository, WorkflowRun } from "../../shared/github/client.ts";
import {
    ISSUE_BODY,
    issueTitle,
    type LoginAccess,
    lifetime,
    type Purpose,
    publishedRunnerKey,
    type SessionAccess,
} from "../../shared/protocol.ts";
import { findSessionRun } from "../../shared/session-run.ts";
import type { Vault } from "../services/vault.ts";

/** One task owned by the current page. Its channel key and account choice never enter browser storage. */
export interface SessionRequest {
    readonly purpose: Purpose;
    readonly account: string;
    readonly requestId: string;
    readonly issue: number;
    readonly startedAt: number;
    readonly key: ChannelKey;
}

/** How long a dispatched session may take to appear before the browser gives up on it. */
const START_GRACE_MS = 15 * 60_000;

/** The connected member's GitHub context, shared by every workflow on the page. */
export interface MemberContext {
    readonly github: GitHubClient;
    readonly user: GitHubUser;
    readonly repository: Repository;
    readonly vault: Vault;
    readonly clock: Clock;
}

/**
 * Starts a task and retains its request in page memory. An unconfirmed dispatch can still be observed on this page.
 */
export async function beginSession(
    member: MemberContext,
    purpose: Purpose,
    signal: AbortSignal,
    options: {
        readonly newMortyIdentity?: boolean;
        readonly access?: SessionAccess;
        readonly loginAccess?: LoginAccess;
        readonly account?: string;
    } = {},
): Promise<SessionRequest> {
    const account = options.account ?? LEGACY_ACCOUNT;
    accountName(account);
    const key = await createChannelKey();
    const requestId = crypto.randomUUID();
    const issue = await member.github.createIssue(
        member.repository.name,
        issueTitle(purpose, requestId),
        ISSUE_BODY,
        signal,
    );
    const session: SessionRequest = {
        purpose,
        account,
        requestId,
        issue,
        startedAt: member.clock.now(),
        key,
    };
    try {
        await member.github.dispatch(
            member.repository,
            purpose,
            {
                ...(purpose === "chat" && account !== LEGACY_ACCOUNT ? { account } : {}),
                request_id: requestId,
                issue: String(issue),
                client_key: key.publicKey,
                ...(purpose === "chat" && options.access === "vscode" ? { access: "vscode" as const } : {}),
                ...(purpose === "login" && options.loginAccess === "vscode" ? { login_access: "vscode" as const } : {}),
                ...(purpose === "chat" && options.newMortyIdentity === true
                    ? { reset_morty_identity: "true" as const }
                    : {}),
            },
            signal,
        );
    } catch (cause) {
        const error = toAppError(cause);
        // GitHub rejected the dispatch outright: nothing will run, so undo the preparation.
        if (isAccessDenied(error.code) || ["unauthenticated", "not_found", "conflict"].includes(error.code)) {
            await closeMailbox(member, session);
            throw error;
        }
        // Anything else is ambiguous; this page keeps the request and finds the run on its next observation.
    }
    return session;
}

export type SessionObservation<TChannel> =
    | { readonly kind: "not_started"; readonly overdue: boolean }
    | { readonly kind: "queued"; readonly run: WorkflowRun }
    | { readonly kind: "running"; readonly run: WorkflowRun; readonly channel: TChannel | null }
    | { readonly kind: "finished"; readonly run: WorkflowRun; readonly channel: TChannel | null };

/** Locates and verifies the run serving a pending session and, once it has published its key, opens the channel. */
export async function observeSession<TOutbound extends MessageSchema, TInbound extends MessageSchema>(
    member: MemberContext,
    session: SessionRequest,
    schemas: { readonly outbound: TOutbound; readonly inbound: TInbound },
    signal: AbortSignal,
): Promise<SessionObservation<SessionChannel<TOutbound, TInbound>>> {
    const expected = {
        repository: member.repository,
        purpose: session.purpose,
        userId: member.user.id,
        requestId: session.requestId,
    };
    const candidates = await member.github.recentSessionRuns(
        member.repository.name,
        member.user,
        session.purpose,
        signal,
    );
    const run = await findSessionRun(member.github, expected, candidates, signal);
    if (run === null) {
        return { kind: "not_started", overdue: member.clock.now() - session.startedAt > START_GRACE_MS };
    }
    if (run.status === "queued" || run.status === "waiting" || run.status === "pending" || run.status === "requested") {
        return { kind: "queued", run };
    }
    const runnerKey = publishedRunnerKey(await member.github.runArtifactNames(member.repository.name, run.id, signal));
    let channel: SessionChannel<TOutbound, TInbound> | null = null;
    if (runnerKey !== null) {
        const binding = {
            repository: member.repository.name,
            purpose: session.purpose,
            issue: session.issue,
            requestId: session.requestId,
            runId: run.id,
            userId: member.user.id,
        };
        channel = new SessionChannel({
            github: member.github,
            binding,
            self: "browser",
            keys: await deriveChannelKeys(session.key, runnerKey, binding, "browser"),
            outbound: schemas.outbound,
            inbound: schemas.inbound,
        });
    }
    return run.status === "completed" ? { kind: "finished", run, channel } : { kind: "running", run, channel };
}

/** Closes the task mailbox; returning to an idle phase releases the page's request and channel key. */
export async function closeMailbox(member: MemberContext, session: SessionRequest): Promise<void> {
    const cleanup = AbortSignal.timeout(10_000);
    try {
        await member.github.closeIssue(member.repository.name, session.issue, cleanup);
    } catch {
        /* The runner also closes the mailbox; a stale open Issue is harmless. */
    }
}

export function sessionExpired(member: MemberContext, session: SessionRequest): boolean {
    return member.clock.now() > session.startedAt + lifetime(session.purpose) + START_GRACE_MS;
}

export function requireRun(observation: SessionObservation<unknown>): WorkflowRun {
    if (observation.kind === "not_started") {
        throw new AppError("not_found");
    }
    return observation.run;
}
