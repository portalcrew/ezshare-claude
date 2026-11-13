import { join } from "node:path";
import * as v from "valibot";
import { cleanupSignal, withDeadline } from "../shared/async.ts";
import { AppError } from "../shared/errors.ts";
import { claudeTokenSchema, mortyUrl, parseJson, requestIdSchema } from "../shared/protocol.ts";
import { agentCommand, runAgentCommand } from "./agent-process.ts";
import type { ActionsContext, StepEnvironment } from "./context.ts";
import { type ChatRunnerChannel, createChatChannel, type RunnerPorts, runSession } from "./session.ts";

const STOP_POLL_MS = 15_000;

const mortyReadySchema = v.object({
    status: v.literal("ready"),
    url: v.pipe(v.string(), v.maxLength(8192)),
    accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
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
            const agent = new AgentSession(context, environment["PATH"] ?? "", token);
            try {
                await withDeadline(Math.max(0, deadline - ports.clock.now()), sessionSignal, async (bounded) => {
                    ports.diagnostics({ event: "session.stage", stage: "starting_agent" });
                    const sessionId = await agent.startClaude(bounded);
                    ports.diagnostics({ event: "session.stage", stage: "connecting_morty" });
                    const ready = await agent.connectMorty(sessionId, bounded);
                    await channel.send({ kind: "ready", body: ready }, bounded);
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
            }
            await channel.send({ kind: "stopped", body: {} }, cleanupSignal(10_000));
        },
    });
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

    constructor(context: ActionsContext, path: string, token: string) {
        this.#context = context;
        this.#path = path;
        this.#workspace = join(context.agent.home, "workspace");
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
                "morty",
                [
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
            { timeout: 240_000, failure: "morty_unavailable", signal },
        );
        for (const line of output.split("\n")) {
            const ready = v.safeParse(mortyReadySchema, safeJson(line.trim()));
            if (!ready.success) {
                continue;
            }
            const url = new URL(mortyUrl(ready.output.url));
            if (
                !v.is(requestIdSchema, sessionId) ||
                url.searchParams.get("sessionId") !== sessionId ||
                url.searchParams.get("workspace") !== this.#workspace
            ) {
                throw new AppError("morty_unavailable");
            }
            return { url: url.href, accessExpiresAt: ready.output.accessExpiresAt };
        }
        throw new AppError("morty_unavailable");
    };

    readonly stopMorty = async (): Promise<void> => {
        try {
            await runAgentCommand(
                await agentCommand(
                    this.#context.agent,
                    this.#path,
                    this.#workspace,
                    "morty",
                    ["stop"],
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
