import { isAbsolute } from "node:path";
import { systemClock } from "../shared/async.ts";
import { AppError, toAppError } from "../shared/errors.ts";
import { GitHubClient } from "../shared/github/client.ts";
import { GITHUB_API_ORIGIN } from "../shared/github/http.ts";
import { prepareChannelKey } from "./channel-key.ts";
import { runChat } from "./chat.ts";
import { readActionsContext } from "./context.ts";
import { writeDiagnostics } from "./diagnostics.ts";
import { runLogin } from "./login.ts";

/**
 * Command line of the Actions runner.
 *
 *   prepare            create this run's channel key (the next step publishes its artifact)
 *   chat | login       serve the session this run was dispatched for
 *   status <owner/repo> list the caller's unfinished sessions (GH_TOKEN is the caller's token)
 */
async function main(args: readonly string[], signal: AbortSignal): Promise<unknown> {
    const ports = { clock: systemClock, diagnostics: writeDiagnostics };
    const [command, ...rest] = args;
    switch (command) {
        case "prepare": {
            const runnerTemp = process.env["RUNNER_TEMP"] ?? "";
            const output = process.env["GITHUB_OUTPUT"] ?? "";
            if (rest.length > 0 || !isAbsolute(runnerTemp) || !isAbsolute(output)) {
                throw new AppError("invalid_input");
            }
            return { kind: "prepared", artifact: (await prepareChannelKey(runnerTemp, output)).name };
        }
        case "chat":
        case "login": {
            if (rest.length > 0) {
                throw new AppError("invalid_input");
            }
            const context = await readActionsContext(process.env, command, signal);
            await (command === "chat" ? runChat : runLogin)(context, process.env, ports, signal);
            return { kind: "session_ended", purpose: command };
        }
        case "status": {
            const [repository, ...extra] = rest;
            if (repository === undefined || extra.length > 0) {
                throw new AppError("invalid_input");
            }
            const github = new GitHubClient(process.env["GH_TOKEN"] ?? "", GITHUB_API_ORIGIN);
            const user = await github.user(signal);
            const sessions = await github.activeSessions(repository, user, signal);
            return {
                kind: "status",
                user: user.login,
                sessions: sessions.map(({ id, path, status }) => ({ id, path, status })),
            };
        }
        default:
            throw new AppError("invalid_input");
    }
}

const lifetime = new AbortController();
const cancel = () => lifetime.abort(new DOMException("Step cancelled", "AbortError"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2), lifetime.signal))}\n`);
} catch (cause) {
    process.stderr.write(`${JSON.stringify({ error: { code: toAppError(cause).code } })}\n`);
    process.exitCode = 1;
} finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
}
