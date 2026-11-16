import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { type Clock, cleanupSignal, withDeadline } from "../shared/async.ts";
import { AppError, toAppError } from "../shared/errors.ts";
import {
    CHAT_IDLE_STOP_MS,
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
import {
    type Diagnostics,
    MORTY_CAUSE_CODES,
    MORTY_ERROR_CODES,
    MORTY_RETRY_CODES,
    type MortyFailureCode,
    type MortyOutputFormat,
    NPM_ERROR_CODES,
    STARTUP_ERROR_CODES,
} from "./diagnostics.ts";
import { claudeProject, type HistoryOwner, latestSessionId, restoreHistory, saveHistory } from "./history-archive.ts";
import { type ChatRunnerChannel, createChatChannel, type RunnerPorts, runSession } from "./session.ts";

const STOP_POLL_MS = 15_000;

const mortyReadySchema = v.object({
    status: v.literal("ready"),
    url: v.pipe(v.string(), v.maxLength(8192)),
    accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
});

const mortyErrorSchema = v.object({
    error: v.object({ code: v.picklist([...MORTY_ERROR_CODES, ...NPM_ERROR_CODES]) }),
});

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
            const agent = new AgentSession(context, path, token, ports.diagnostics, ports.clock);
            const owner = { repository: context.repository, userId: context.userId };
            const archive = historyArchivePath(context.runnerTemp);
            // Set only once the agent's home holds exactly what may be saved over the member's archive.
            let saving: { readonly key: string; readonly sessionId: string } | null = null;
            let history: HistoryEnd = "not_archived";
            try {
                await withDeadline(
                    Math.max(0, deadline - ports.clock.now()),
                    sessionSignal,
                    async (bounded) => {
                        ports.diagnostics({ event: "session.stage", stage: "awaiting_history" });
                        const request = await waitForHistory(channel, deadline, ports, bounded);
                        if (request.kind === "stop") {
                            return;
                        }
                        let start: HistoryStart;
                        let restoredSession: string | null = null;
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
                        ports.diagnostics({ event: "session.stage", stage: "starting_agent" });
                        const sessionId = restoredSession ?? (await agent.startClaude(bounded));
                        await agent.verifyClaudeSession(sessionId, bounded);
                        ports.diagnostics({ event: "session.stage", stage: "verified_history" });
                        if (start !== "unreadable") {
                            saving = { key: request.key, sessionId };
                        }
                        if (context.inputs.reset_morty_identity === "true") {
                            ports.diagnostics({ event: "session.stage", stage: "resetting_morty_identity" });
                            await agent.resetMortyIdentity(bounded);
                        }
                        ports.diagnostics({ event: "session.stage", stage: "connecting_morty" });
                        const ready = await agent.connectMorty(sessionId, bounded);
                        await channel.send({ kind: "ready", body: { ...ready, history: start } }, bounded);
                        ports.diagnostics({ event: "session.stage", stage: "ready" });
                        await waitForStop(channel, deadline, ports, agent.activity, bounded);
                    },
                    ports.clock,
                );
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
 * Waits for the browser's personal key before starting any Agent or Computer. A missing key must never silently
 * turn a continuing session into a new identity with empty history.
 */
async function waitForHistory(
    channel: ChatRunnerChannel,
    deadline: number,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<{ readonly kind: "history"; readonly key: string; readonly mode: HistoryMode } | { readonly kind: "stop" }> {
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
            throw new AppError("history_key_missing");
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

/**
 * Waits until the member asks to stop, the lifetime ends, or the conversation has been idle for `CHAT_IDLE_STOP_MS`.
 * `activity` fingerprints the Claude transcripts; a changed fingerprint is a new turn. An unreadable fingerprint
 * counts as activity, so a probe failure can never end a session early.
 */
async function waitForStop(
    channel: ChatRunnerChannel,
    deadline: number,
    ports: RunnerPorts,
    activity: (signal: AbortSignal) => Promise<string | null>,
    signal: AbortSignal,
): Promise<void> {
    let fingerprint = await activity(signal);
    let lastActive = ports.clock.now();
    while (ports.clock.now() < deadline) {
        const messages = await channel.receive(signal);
        if (messages.some((message) => message.kind === "stop")) {
            return;
        }
        const current = await activity(signal);
        const now = ports.clock.now();
        if (current === null || current !== fingerprint) {
            fingerprint = current;
            lastActive = now;
        }
        const idleUntil = lastActive + CHAT_IDLE_STOP_MS;
        if (now >= idleUntil) {
            ports.diagnostics({ event: "session.stage", stage: "idle" });
            return;
        }
        await ports.clock.sleep(Math.min(STOP_POLL_MS, deadline - now, idleUntil - now), signal);
    }
}

class AgentSession {
    readonly #context: ActionsContext;
    readonly #path: string;
    readonly #variables: Readonly<Record<string, string>>;
    readonly #workspace: string;
    readonly #diagnostics: Diagnostics;
    readonly #clock: Clock;

    constructor(context: ActionsContext, path: string, token: string, diagnostics: Diagnostics, clock: Clock) {
        this.#clock = clock;
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

    /** Verify the archived native transcript before handing its session id to Morty. */
    readonly verifyClaudeSession = async (sessionId: string, signal: AbortSignal): Promise<void> => {
        await runAgentCommand(
            await agentCommand(
                this.#context.agent,
                this.#path,
                this.#workspace,
                "test",
                ["-s", join(this.#context.agent.home, claudeProject(this.#workspace), `${sessionId}.jsonl`)],
                this.#variables,
            ),
            { timeout: 10_000, failure: "agent_failed", signal },
        );
    };

    /** Removes only the dedicated Morty directory, as the agent, after its home has been restored. */
    readonly resetMortyIdentity = async (signal: AbortSignal): Promise<void> => {
        await runAgentCommand(
            await agentCommand(
                this.#context.agent,
                this.#path,
                this.#context.agent.home,
                "rm",
                ["-rf", "--", join(this.#context.agent.home, "morty")],
                {},
            ),
            { timeout: 30_000, failure: "morty_unavailable", signal },
        );
    };

    readonly connectMorty = async (
        sessionId: string,
        signal: AbortSignal,
    ): Promise<{ readonly url: string; readonly accessExpiresAt: string }> => {
        const command = await agentCommand(
            this.#context.agent,
            this.#path,
            this.#workspace,
            "npx",
            [
                "--yes",
                "--prefer-online",
                "--json",
                "@portalcrew/morty@latest",
                "setup",
                "--base-url",
                "https://morty.build",
                "--cwd",
                this.#workspace,
                "--harness",
                "claude",
                "--session-id",
                sessionId,
                // Morty offers 1h, 1d, 7d or 30d; the session itself ends within its lifetime.
                "--device-access",
                "1d",
            ],
            this.#variables,
        );
        const output = await withDeadline(
            240_000,
            signal,
            async (bounded) => {
                for (let attempt = 1; ; attempt += 1) {
                    const failures: { readonly code: MortyFailureCode; readonly exitCode: number | null }[] = [];
                    try {
                        return await runAgentCommand(command, {
                            timeout: 240_000,
                            failure: "morty_unavailable",
                            signal: bounded,
                            onFailure: ({ stdout, stderr, exitCode }) => {
                                failures.push({ code: mortyFailureCode(stdout, stderr), exitCode });
                                reportMortyCauses(stdout, stderr, this.#diagnostics);
                                this.#diagnostics({
                                    event: "morty.output",
                                    stdout: mortyOutputFormat(stdout),
                                    stderr: mortyOutputFormat(stderr),
                                });
                            },
                        });
                    } catch (cause) {
                        const failure = failures.at(-1);
                        if (bounded.aborted || failure === undefined) {
                            throw cause;
                        }
                        // npm can accept a publish before its metadata and archive are available everywhere.
                        // E404 gets up to 165 seconds of waits within the shared four-minute startup deadline.
                        // Setup persists pairing request identities, so transient service failures can resume safely.
                        // Authentication and revoked credentials require their owning recovery flow.
                        if (
                            !v.is(v.picklist(MORTY_RETRY_CODES), failure.code) ||
                            attempt >= (failure.code === "E404" ? 12 : 3)
                        ) {
                            this.#diagnostics({ event: "morty.failed", ...failure });
                            throw cause;
                        }
                        this.#diagnostics({ event: "morty.retrying", code: failure.code, attempt });
                        await this.#clock.sleep(15_000, bounded);
                    }
                }
            },
            this.#clock,
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

    /** Names, sizes and modification times of the Claude transcripts, or null if they cannot be listed. */
    readonly activity = async (signal: AbortSignal): Promise<string | null> => {
        try {
            const output = await runAgentCommand(
                await agentCommand(
                    this.#context.agent,
                    this.#path,
                    this.#context.agent.home,
                    "find",
                    [
                        claudeProject(this.#workspace),
                        "-maxdepth",
                        "1",
                        "-type",
                        "f",
                        "-name",
                        "*.jsonl",
                        "-printf",
                        "%f %s %T@\\n",
                    ],
                    {},
                ),
                { timeout: 15_000, failure: "agent_failed", signal },
            );
            return output.split("\n").sort().join("\n");
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            return null;
        }
    };

    readonly stopMorty = async (): Promise<void> => {
        try {
            await runAgentCommand(
                await agentCommand(
                    this.#context.agent,
                    this.#path,
                    this.#workspace,
                    "npx",
                    ["--yes", "--prefer-online", "--json", "@portalcrew/morty@latest", "stop"],
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

function reportMortyCauses(stdout: string, stderr: string, diagnostics: Diagnostics): void {
    const envelope = v.object({ error: v.unknown() });
    const node = v.object({ code: v.optional(v.unknown()), cause: v.optional(v.unknown()) });
    for (const candidate of [stdout, stderr, ...stdout.split("\n"), ...stderr.split("\n")]) {
        const parsed = v.safeParse(envelope, safeJson(candidate.trim()));
        if (!parsed.success) {
            continue;
        }
        let current: unknown = parsed.output.error;
        for (let depth = 0; depth < 6; depth += 1) {
            const result = v.safeParse(node, current);
            if (!result.success) {
                break;
            }
            if (depth > 0 && v.is(v.picklist(MORTY_CAUSE_CODES), result.output.code)) {
                diagnostics({ event: "morty.cause", code: result.output.code, depth });
            }
            current = result.output.cause;
        }
        return;
    }
}

/** npm emits a whole JSON document; Morty emits one JSON document per line. Discard all private fields. */
function mortyFailureCode(stdout: string, stderr: string): MortyFailureCode {
    for (const candidate of [stdout, stderr, ...stdout.split("\n"), ...stderr.split("\n")]) {
        const parsed = v.safeParse(mortyErrorSchema, safeJson(candidate.trim()));
        if (parsed.success) {
            return parsed.output.error.code;
        }
    }
    const text = `${stdout}\n${stderr}`;
    for (const code of STARTUP_ERROR_CODES) {
        if (text.includes(`Error [${code}]:`) || text.includes(`code: '${code}'`)) {
            return code;
        }
    }
    if (stderr.startsWith("Morty requires Node.js ")) {
        return "NODE_RUNTIME_INCOMPATIBLE";
    }
    if (stderr.startsWith("error: unknown ") || stderr.startsWith("error: required option ")) {
        return "CLI_ARGUMENT_REJECTED";
    }
    if (stderr.startsWith("Morty daemon failed: ")) {
        return "DAEMON_FAILED";
    }
    for (const code of NPM_ERROR_CODES) {
        if (stderr.split("\n").some((line) => line === `npm error code ${code}` || line === `npm ERR! code ${code}`)) {
            return code;
        }
    }
    if (stderr.startsWith("npm error ")) {
        return "NPM_FAILED";
    }
    return "UNRECOGNIZED";
}

function mortyOutputFormat(output: string): MortyOutputFormat {
    if (output.trim() === "") {
        return "empty";
    }
    if (safeJson(output.trim()) !== null) {
        return "json";
    }
    if (output.split("\n").some((line) => safeJson(line.trim()) !== null)) {
        return "ndjson";
    }
    return "text";
}
