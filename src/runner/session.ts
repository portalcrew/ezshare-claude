import * as v from "valibot";
import { type Clock, cleanupSignal } from "../shared/async.ts";
import { type MessageSchema, SessionChannel } from "../shared/channel.ts";
import { type ChannelKeys, deriveChannelKeys } from "../shared/channel-crypto.ts";
import { AppError, toAppError } from "../shared/errors.ts";
import { GitHubClient } from "../shared/github/client.ts";
import {
    type ChannelBinding,
    chatBrowserMessageSchema,
    chatRunnerMessageSchema,
    issueTitle,
    lifetime,
    loginBrowserMessageSchema,
    loginRunnerMessageSchema,
    publishedRunnerKey,
    type RunnerFailure,
    runnerFailureSchema,
} from "../shared/protocol.ts";
import { verifySessionRun } from "../shared/session-run.ts";
import { loadChannelKey } from "./channel-key.ts";
import type { ActionsContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";

export interface RunnerPorts {
    readonly clock: Clock;
    readonly diagnostics: Diagnostics;
}

export type ChatRunnerChannel = SessionChannel<typeof chatRunnerMessageSchema, typeof chatBrowserMessageSchema>;
export type LoginRunnerChannel = SessionChannel<typeof loginRunnerMessageSchema, typeof loginBrowserMessageSchema>;

interface VerifiedSession {
    readonly github: GitHubClient;
    readonly binding: ChannelBinding;
    readonly deadline: number;
}

/**
 * Verifies the step against GitHub before any session work: the run is the member's own first attempt of this
 * workflow on the default branch, the mailbox Issue is the member's, and this run's channel artifact is published.
 */
async function verify(context: ActionsContext, ports: RunnerPorts, signal: AbortSignal): Promise<VerifiedSession> {
    const github = new GitHubClient(context.token, context.apiOrigin);
    const repository = await github.repository(context.repository, signal);
    if (context.ref !== `refs/heads/${repository.defaultBranch}`) {
        throw new AppError("unsafe_execution");
    }
    verifySessionRun(await github.run(context.repository, context.runId, signal), {
        repository,
        purpose: context.purpose,
        userId: context.userId,
        requestId: context.inputs.request_id,
    });
    const issueNumber = Number(context.inputs.issue);
    const issue = await github.issue(context.repository, issueNumber, signal);
    if (
        issue.isPullRequest ||
        issue.state !== "open" ||
        issue.authorId !== context.userId ||
        issue.title !== issueTitle(context.purpose, context.inputs.request_id)
    ) {
        throw new AppError("unsafe_execution");
    }
    return {
        github,
        binding: {
            repository: context.repository,
            purpose: context.purpose,
            issue: issueNumber,
            requestId: context.inputs.request_id,
            runId: context.runId,
            userId: context.userId,
        },
        deadline: ports.clock.now() + lifetime(context.purpose),
    };
}

const ARTIFACT_CHECKS = 6;
const ARTIFACT_CHECK_INTERVAL_MS = 5_000;

/** Loads this run's key and waits until GitHub lists it as published, so the browser can find the same key. */
async function channelKeys(
    context: ActionsContext,
    session: VerifiedSession,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<ChannelKeys> {
    const own = await loadChannelKey(context.runnerTemp);
    for (let check = 1; ; check++) {
        const published = publishedRunnerKey(
            await session.github.runArtifactNames(context.repository, context.runId, signal),
        );
        if (published === own.publicKey) {
            return deriveChannelKeys(own, context.inputs.client_key, session.binding, "runner");
        }
        if (published !== null || check === ARTIFACT_CHECKS) {
            throw new AppError("unsafe_execution");
        }
        await ports.clock.sleep(ARTIFACT_CHECK_INTERVAL_MS, signal);
    }
}

export interface SessionHandle<TChannel> {
    readonly channel: TChannel;
    readonly deadline: number;
}

/**
 * Runs one session purpose with the shared outcome rules: an authenticated failure report when possible, and the
 * mailbox closed on every exit path. Verification failures are not reported, because the peer is unproven.
 */
export async function runSession<TChannel>(
    context: ActionsContext,
    ports: RunnerPorts,
    signal: AbortSignal,
    protocol: {
        readonly create: (github: GitHubClient, binding: ChannelBinding, keys: ChannelKeys) => TChannel;
        readonly work: (session: SessionHandle<TChannel>, signal: AbortSignal) => Promise<void>;
        readonly reportFailure: (channel: TChannel, code: RunnerFailure, signal: AbortSignal) => Promise<void>;
    },
): Promise<void> {
    ports.diagnostics({ event: "session.stage", stage: "verifying" });
    const session = await verify(context, ports, signal);
    try {
        const channel = protocol.create(
            session.github,
            session.binding,
            await channelKeys(context, session, ports, signal),
        );
        ports.diagnostics({ event: "session.stage", stage: "verified" });
        try {
            await protocol.work({ channel, deadline: session.deadline }, signal);
        } catch (cause) {
            const error = toAppError(cause);
            ports.diagnostics({ event: "session.failed", code: error.code });
            if (error.code !== "cancelled") {
                await bestEffort(() => protocol.reportFailure(channel, reportable(error.code), cleanupSignal(10_000)));
            }
            throw error;
        }
    } finally {
        await bestEffort(() =>
            session.github.closeIssue(context.repository, session.binding.issue, cleanupSignal(10_000)),
        );
        ports.diagnostics({ event: "session.stage", stage: "closed" });
    }
}

/** Creates the runner's end of a session channel for one purpose's message schemas. */
function runnerChannel<TOutbound extends MessageSchema, TInbound extends MessageSchema>(
    outbound: TOutbound,
    inbound: TInbound,
): (github: GitHubClient, binding: ChannelBinding, keys: ChannelKeys) => SessionChannel<TOutbound, TInbound> {
    return (github, binding, keys) => new SessionChannel({ github, binding, self: "runner", keys, outbound, inbound });
}

export const createChatChannel = runnerChannel(chatRunnerMessageSchema, chatBrowserMessageSchema);
export const createLoginChannel = runnerChannel(loginRunnerMessageSchema, loginBrowserMessageSchema);

function reportable(code: string): RunnerFailure {
    const parsed = v.safeParse(runnerFailureSchema.entries.code, code);
    return parsed.success ? parsed.output : "unexpected";
}

async function bestEffort(operation: () => Promise<void>): Promise<void> {
    try {
        await operation();
    } catch {
        /* Cleanup must not replace the session outcome; the job VM is discarded afterwards. */
    }
}
