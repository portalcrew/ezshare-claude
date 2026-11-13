import { withDeadline } from "../shared/async.ts";
import { agentCommand } from "./agent-process.ts";
import { ClaudeTerminal } from "./claude-terminal.ts";
import type { ActionsContext, StepEnvironment } from "./context.ts";
import { createLoginChannel, type LoginRunnerChannel, type RunnerPorts, runSession } from "./session.ts";

const CODE_POLL_MS = 5_000;
const AUTHORIZATION_URL_TIMEOUT_MS = 90_000;

/**
 * The account owner's login: run `claude setup-token`, hand its authorization link to the owner's browser,
 * enter the code the owner returns, and send the resulting token back. Only the owner's browser can read it.
 */
export async function runLogin(
    context: ActionsContext,
    environment: StepEnvironment,
    ports: RunnerPorts,
    signal: AbortSignal,
): Promise<void> {
    await runSession(context, ports, signal, {
        create: createLoginChannel,
        reportFailure: (channel, code, failureSignal) =>
            channel.send({ kind: "failed", body: { code } }, failureSignal),
        work: async ({ channel, deadline }, sessionSignal) => {
            const command = await agentCommand(
                context.agent,
                environment["PATH"] ?? "",
                context.agent.home,
                "claude",
                ["setup-token"],
                {
                    TERM: "xterm-256color",
                    BROWSER: "false",
                    DISABLE_AUTOUPDATER: "1",
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                },
            );
            const terminal = new ClaudeTerminal(command);
            try {
                await withDeadline(
                    Math.max(0, deadline - ports.clock.now()),
                    sessionSignal,
                    async (bounded) => {
                        const url = await withDeadline(AUTHORIZATION_URL_TIMEOUT_MS, bounded, terminal.authorization);
                        await channel.send({ kind: "challenge", body: { url } }, bounded);
                        ports.diagnostics({ event: "session.stage", stage: "awaiting_authorization" });
                        const code = await waitForCode(channel, ports, bounded);
                        ports.diagnostics({ event: "session.stage", stage: "completing_authorization" });
                        const token = await terminal.complete(code, bounded);
                        await channel.send({ kind: "token", body: { token } }, bounded);
                        ports.diagnostics({ event: "session.stage", stage: "authorized" });
                    },
                    ports.clock,
                );
            } finally {
                await terminal.dispose();
            }
        },
    });
}

async function waitForCode(channel: LoginRunnerChannel, ports: RunnerPorts, signal: AbortSignal): Promise<string> {
    for (;;) {
        // The first code wins; a browser that resent after an unconfirmed post sends the same code again.
        const code = (await channel.receive(signal)).find((message) => message.kind === "code");
        if (code !== undefined) {
            return code.body.code;
        }
        await ports.clock.sleep(CODE_POLL_MS, signal);
    }
}
