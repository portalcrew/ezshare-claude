import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { cleanupSignal, withDeadline } from "../shared/async.ts";
import { AppError, toAppError } from "../shared/errors.ts";
import {
    claudeTokenSchema,
    type HistoryEnd,
    type HistoryMode,
    type HistoryStart,
    mortyUrl,
    parseJson,
    requestIdSchema,
} from "../shared/protocol.ts";
import { agentCommand, runAgentCommand } from "./agent-process.ts";
import { type ActionsContext, agentWorkspace, historyArchivePath, type StepEnvironment } from "./context.ts";
import { type Diagnostics, MORTY_ERROR_CODES } from "./diagnostics.ts";
import { type HistoryOwner, latestSessionId, restoreHistory, saveHistory } from "./history-archive.ts";
import { type ChatRunnerChannel, createChatChannel, type RunnerPorts, runSession } from "./session.ts";

const STOP_POLL_MS = 15_000;

const mortyReadySchema = v.object({
    status: v.literal("ready"),
    url: v.pipe(v.string(), v.maxLength(8192)),
    accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
});

const mortyErrorSchema = v.object({ error: v.object({ code: v.picklist(MORTY_ERROR_CODES) }) });

/**
 * A member's personal Claude session: start Claude with the shared account in a fresh workspace, connect it to
 * Morty, hand the Morty link to the member's browser, and stop when the member asks or the lifetime ends.
 */
export async function runChat(
    context: ActionsContext,
    environment: StepEnvironment,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<void> {
    await runSession(context, ports, signal, {
        create: createChatChannel,
        reportFailure: (channel, code, failureSignal) =>
            channel.send({ kind: "failed", body: { code } }, failureSignal),
        work: async ({ channel, deadline }, sessionSignal) => {
            const token = environment["EZSHARE_CLAUDE_TOKEN"] ?? "";
            if (!v.is(claudeTokenSchema, token)) {
                throw new AppError("shared_account_missing");
            }
            const path = environment["PATH"] ?? "";
            const agent = new AgentSession(context, path, token, ports.diagnostics);
            const owner = { repository: context.repository, userId: context.userId };
            const archive = historyArchivePath(context.runnerTemp);
            // Set only once the agent's home holds exactly what may be saved over the member's archive.
            let saving: { readonly key: string; readonly sessionId: string } | null = null;
            let history: HistoryEnd = "not_archived";
            try {
                await withDeadline(Math.max(0, deadline - ports.clock.now()), sessionSignal, async (bounded) => {
                    ports.diagnostics({ event: "session.stage", stage: "awaiting_history" });
                    const request = await waitForHistory(channel, deadline, ports, bounded);
                    if (request.kind === "stop") {
                        return;
                    }
                    let start: HistoryStart = "off";
                    let restoredSession: string | null = null;
                    if (request.kind === "history") {
                        ports.diagnostics({ event: "session.stage", stage: "restoring_history" });
                        const restored =
                            request.mode === "replace"
                                ? ({ kind: "none" } as const)
                                : await restoreHistory(archive, request.key, owner, context.agent, path, bounded);
                        switch (restored.kind) {
                            case "none":
                                start = "new";
                                break;
                            case "unreadable":
                                start = "unreadable";
                                break;
                            case "restored":
                                start = "restored";
                                restoredSession = restored.sessionId;
                                break;
                            default:
                                return restored satisfies never;
                        }
                    }
                    ports.diagnostics({ event: "session.stage", stage: "starting_agent" });
                    // A restored conversation already has its Claude session; only a new one needs creating.
                    const sessionId = restoredSession ?? (await agent.startClaude(bounded));
                    if (request.kind === "history" && start !== "unreadable") {
                        saving = { key: request.key, sessionId };
                    }
                    ports.diagnostics({ event: "session.stage", stage: "connecting_morty" });
                    const ready = await agent.connectMorty(sessionId, bounded);
                    await channel.send({ kind: "ready", body: { ...ready, history: start } }, bounded);
                    ports.diagnostics({ event: "session.stage", stage: "ready" });
                    await waitForStop(channel, deadline, ports, bounded);
                });
            } catch (cause) {
                // Reaching the session's lifetime is its normal end, not a failure.
                if (!(cause instanceof AppError && cause.code === "timeout" && ports.clock.now() >= deadline)) {
                    throw cause;
                }
            } finally {
                ports.diagnostics({ event: "session.stage", stage: "stopping" });
                await agent.stopMorty();
                if (saving !== null) {
                    history = await archiveHistory(context, path, owner, archive, saving, ports);
                }
            }
            await channel.send({ kind: "stopped", body: { history } }, cleanupSignal(10_000));
        },
    });
}

const HISTORY_WAIT_MS = 5 * 60_000;
const HISTORY_POLL_MS = 3_000;
const SAVE_TIMEOUT_MS = 6 * 60_000;

/**
 * Waits for the member's browser to hand over the history key. A browser that stays away (the launcher page was
 * closed while the run started) leaves this session without history rather than blocking it.
 */
async function waitForHistory(
    channel: ChatRunnerChannel,
    deadline: number,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<
    | { readonly kind: "history"; readonly key: string; readonly mode: HistoryMode }
    | { readonly kind: "stop" }
    | { readonly kind: "absent" }
> {
    const until = Math.min(deadline, ports.clock.now() + HISTORY_WAIT_MS);
    for (;;) {
        const messages = await channel.receive(signal);
        if (messages.some((message) => message.kind === "stop")) {
            return { kind: "stop" };
        }
        // The first key wins; a reloaded browser may send its key again.
        const history = messages.find((message) => message.kind === "history");
        if (history !== undefined) {
            return { kind: "history", key: history.body.key, mode: history.body.mode };
        }
        if (ports.clock.now() >= until) {
            return { kind: "absent" };
        }
        await ports.clock.sleep(Math.min(HISTORY_POLL_MS, until - ports.clock.now()), signal);
    }
}

/** Archives the agent's home for the next session and tells the save step to keep it. Never fails the session. */
async function archiveHistory(
    context: ActionsContext,
    path: string,
    owner: HistoryOwner,
    archive: string,
    saving: { readonly key: string; readonly sessionId: string },
    ports: RunnerPorts,
): Promise<HistoryEnd> {
    ports.diagnostics({ event: "session.stage", stage: "saving_history" });
    try {
        const signal = cleanupSignal(SAVE_TIMEOUT_MS);
        const sessionId = await latestSessionId(
            context.agent,
            path,
            agentWorkspace(context.agent),
            saving.sessionId,
            signal,
        );
        await saveHistory(archive, saving.key, owner, context.agent, path, sessionId, signal);
        await appendFile(context.githubOutput, "history=archived\n");
        return "archived";
    } catch (cause) {
        ports.diagnostics({ event: "session.failed", code: toAppError(cause).code });
        return "not_archived";
    }
}

async function waitForStop(
    channel: ChatRunnerChannel,
    deadline: number,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<void> {
    while (ports.clock.now() < deadline) {
        const messages = await channel.receive(signal);
        if (messages.some((message) => message.kind === "stop")) {
            return;
        }
        await ports.clock.sleep(Math.min(STOP_POLL_MS, deadline - ports.clock.now()), signal);
    }
}

class AgentSession {
    readonly #context: ActionsContext;
    readonly #path: string;
    readonly #variables: Readonly<Record<string, string>>;
    readonly #workspace: string;
    readonly #diagnostics: Diagnostics;

    constructor(context: ActionsContext, path: string, token: string, diagnostics: Diagnostics) {
        this.#context = context;
        this.#diagnostics = diagnostics;
        this.#path = path;
        this.#workspace = agentWorkspace(context.agent);
        this.#variables = {
            TERM: "xterm-256color",
            BROWSER: "false",
            NO_BROWSER: "1",
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_OAUTH_TOKEN: token,
            MORTY_STATE_DIRECTORY: join(context.agent.home, "morty"),
        };
    }

    readonly startClaude = async (signal: AbortSignal): Promise<string> => {
        const sessionId = crypto.randomUUID();
        const output = await runAgentCommand(
            await agentCommand(
                this.#context.agent,
                this.#path,
                this.#workspace,
                "claude",
                [
                    "-p",
                    "Reply with exactly: READY",
                    "--output-format",
                    "json",
                    "--session-id",
                    sessionId,
                    "--max-turns",
                    "1",
                    "--tools",
                    "",
                    "--model",
                    "sonnet",
                ],
                this.#variables,
            ),
            { timeout: 180_000, failure: "agent_failed", signal },
        );
        const result = v.safeParse(
            v.object({ type: v.literal("result"), is_error: v.literal(false), session_id: v.literal(sessionId) }),
            safeJson(output.trim()),
        );
        if (!result.success) {
            throw new AppError("agent_failed");
        }
        return sessionId;
    };

    readonly connectMorty = async (
        sessionId: string,
        signal: AbortSignal,
    ): Promise<{ readonly url: string; readonly accessExpiresAt: string }> => {
        const output = await runAgentCommand(
            await agentCommand(
                this.#context.agent,
                this.#path,
                this.#workspace,
                "npx",
                [
                    "--yes",
                    "@morty-build/cli@latest",
                    "setup",
                    "--base-url",
                    "https://morty.build",
                    "--cwd",
                    this.#workspace,
                    "--harness",
                    "claude",
                    "--session-id",
                    sessionId,
                    "--device-access",
                    "1h",
                ],
                this.#variables,
            ),
            {
                timeout: 240_000,
                failure: "morty_unavailable",
                signal,
                onFailure: ({ stdout, exitCode }) => {
                    for (const line of stdout.split("\n")) {
                        const result = v.safeParse(mortyErrorSchema, safeJson(line.trim()));
                        if (result.success) {
                            this.#diagnostics({ event: "morty.failed", code: result.output.error.code, exitCode });
                            return;
                        }
                    }
                    this.#diagnostics({ event: "morty.failed", code: "UNRECOGNIZED", exitCode });
                },
            },
        );
        for (const line of output.split("\n")) {
            const ready = v.safeParse(mortyReadySchema, safeJson(line.trim()));
            if (!ready.success) {
                continue;
            }
            let url: URL;
            try {
                url = new URL(mortyUrl(ready.output.url));
            } catch (cause) {
                this.#diagnostics({ event: "morty.failed", code: "HANDOFF_MISMATCH", exitCode: 0 });
                throw new AppError("morty_unavailable", { cause });
            }
            const queryWorkspace = url.searchParams.get("workspace");
            const workspace = new URLSearchParams(url.hash.slice(1)).get("workspace") ?? queryWorkspace;
            if (
                !v.is(requestIdSchema, sessionId) ||
                url.searchParams.get("sessionId") !== sessionId ||
                workspace !== this.#workspace ||
                (queryWorkspace !== null && queryWorkspace !== workspace)
            ) {
                this.#diagnostics({ event: "morty.failed", code: "HANDOFF_MISMATCH", exitCode: 0 });
                throw new AppError("morty_unavailable");
            }
            return { url: url.href, accessExpiresAt: ready.output.accessExpiresAt };
        }
        this.#diagnostics({ event: "morty.failed", code: "READY_OUTPUT_INVALID", exitCode: 0 });
        throw new AppError("morty_unavailable");
    };

    readonly stopMorty = async (): Promise<void> => {
        try {
            await runAgentCommand(
                await agentCommand(
                    this.#context.agent,
                    this.#path,
                    this.#workspace,
                    "npx",
                    ["--yes", "@morty-build/cli@latest", "stop"],
                    this.#variables,
                ),
                { timeout: 15_000, failure: "morty_unavailable", signal: cleanupSignal(20_000) },
            );
        } catch {
            /* Morty may not have started; the job VM is discarded when the step ends. */
        }
    };
}

function safeJson(text: string): unknown {
    if (!text.startsWith("{")) {
        return null;
    }
    try {
        return parseJson(text);
    } catch {
        return null;
    }
}
