import type * as v from "valibot";
import type { Clock } from "../../shared/async.ts";
import { SessionChannel } from "../../shared/channel.ts";
import { createChannelKey, deriveChannelKeys } from "../../shared/channel-crypto.ts";
import { AppError, toAppError } from "../../shared/errors.ts";
import type { GitHubClient, GitHubUser, Repository, WorkflowRun } from "../../shared/github/client.ts";
import { ISSUE_BODY, issueTitle, lifetime, type Purpose, publishedRunnerKey } from "../../shared/protocol.ts";
import { findSessionRun } from "../../shared/session-run.ts";
import type { PendingSession, Vault } from "../services/vault.ts";

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
 * Starts a session: the mailbox Issue and the pending record exist before the dispatch, so a reload or an
 * unconfirmed dispatch can always be observed and cleaned up later.
 */
export async function beginSession(
    member: MemberContext,
    purpose: Purpose,
    signal: AbortSignal,
): Promise<PendingSession> {
    const key = await createChannelKey();
    const requestId = crypto.randomUUID();
    const issue = await member.github.createIssue(
        member.repository.name,
        issueTitle(purpose, requestId),
        ISSUE_BODY,
        signal,
    );
    const session: PendingSession = {
        purpose,
        repository: member.repository.name,
        userId: member.user.id,
        requestId,
        issue,
        startedAt: member.clock.now(),
        key,
    };
    await member.vault.savePending(session, signal);
    try {
        await member.github.dispatch(
            member.repository,
            purpose,
            { request_id: requestId, issue: String(issue), client_key: key.publicKey },
            signal,
        );
    } catch (cause) {
        const error = toAppError(cause);
        // GitHub rejected the dispatch outright: nothing will run, so undo the preparation.
        if (["unauthenticated", "forbidden", "not_found", "conflict"].includes(error.code)) {
            await abandonSession(member, session);
            throw error;
        }
        // Anything else is ambiguous; the pending record lets the next observation find the run.
    }
    return session;
}

export type SessionObservation<TChannel> =
    | { readonly kind: "not_started"; readonly overdue: boolean }
    | { readonly kind: "queued"; readonly run: WorkflowRun }
    | { readonly kind: "running"; readonly run: WorkflowRun; readonly channel: TChannel | null }
    | { readonly kind: "finished"; readonly run: WorkflowRun; readonly channel: TChannel | null };

type MessageSchema = v.GenericSchema<unknown, { readonly kind: string; readonly body: unknown }>;

/** Locates and verifies the run serving a pending session and, once it has published its key, opens the channel. */
export async function observeSession<TOutbound extends MessageSchema, TInbound extends MessageSchema>(
    member: MemberContext,
    session: PendingSession,
    schemas: { readonly outbound: TOutbound; readonly inbound: TInbound },
    signal: AbortSignal,
): Promise<SessionObservation<SessionChannel<TOutbound, TInbound>>> {
    const expected = {
        repository: member.repository,
        purpose: session.purpose,
        userId: session.userId,
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
            userId: session.userId,
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

/** A session is over for this browser: forget its key, so its messages can never be read again. */
export async function abandonSession(member: MemberContext, session: PendingSession): Promise<void> {
    const cleanup = AbortSignal.timeout(10_000);
    try {
        await member.github.closeIssue(member.repository.name, session.issue, cleanup);
    } catch {
        /* The runner also closes the mailbox; a stale open Issue is harmless. */
    }
    await member.vault.forgetPending(session.purpose, session.repository, session.userId, cleanup);
}

export function sessionExpired(member: MemberContext, session: PendingSession): boolean {
    return member.clock.now() > session.startedAt + lifetime(session.purpose) + START_GRACE_MS;
}

export function requireRun(observation: SessionObservation<unknown>): WorkflowRun {
    if (observation.kind === "not_started") {
        throw new AppError("not_found");
    }
    return observation.run;
}
