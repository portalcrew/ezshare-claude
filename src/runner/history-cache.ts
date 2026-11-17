import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { AppError } from "../shared/errors.ts";
import { GitHubHttp } from "../shared/github/http.ts";
import { requestIdSchema } from "../shared/protocol.ts";
import { runAgentCommand } from "./agent-process.ts";
import { type ActionsContext, historyArchivePath, type StepEnvironment } from "./context.ts";

/** Durable encrypted snapshots; the controller alone owns cache credentials. */
export interface HistoryCache {
    readonly save: (key: string, archive: string, signal: AbortSignal) => Promise<void>;
    readonly remove: (key: string, signal: AbortSignal) => Promise<void>;
}

export function createActionsHistoryCache(context: ActionsContext, environment: StepEnvironment): HistoryCache {
    const prefix = `ezshare-history-${context.userId}-run-${context.runId}-checkpoint-`;
    const http = new GitHubHttp(context.token, context.apiOrigin);
    const checkKey = (key: string): void => {
        if (!key.startsWith(prefix) || !v.is(requestIdSchema, key.slice(prefix.length))) {
            throw new AppError("unsafe_execution");
        }
    };
    const env: Record<string, string> = { ACTIONS_CACHE_SERVICE_V2: "true" };
    for (const name of [
        "PATH",
        "HOME",
        "RUNNER_TEMP",
        "GITHUB_WORKSPACE",
        "GITHUB_REPOSITORY",
        "GITHUB_REF",
        "ACTIONS_RUNTIME_TOKEN",
        "ACTIONS_CACHE_URL",
        "ACTIONS_RESULTS_URL",
        "ACTIONS_CACHE_MODE",
    ]) {
        const value = environment[name];
        if (value !== undefined) {
            env[name] = value;
        }
    }
    return {
        save: async (key, archive, signal) => {
            checkKey(key);
            if (archive !== historyArchivePath(context.runnerTemp)) {
                throw new AppError("unsafe_execution");
            }
            // timeout supervises the SDK's process group, including its tar and upload children.
            await runAgentCommand(
                {
                    command: "timeout",
                    args: [
                        "--kill-after=5s",
                        "300s",
                        "node",
                        fileURLToPath(new URL("./history-cache-worker.ts", import.meta.url)),
                        key,
                        dirname(archive),
                    ],
                    env,
                },
                { timeout: 310_000, failure: "github_unavailable", signal },
            );
        },
        remove: async (key, signal) => {
            checkKey(key);
            await http.delete(
                `/repos/${context.repository}/actions/caches?key=${encodeURIComponent(key)}&ref=${encodeURIComponent(context.ref)}`,
                signal,
                "actions_write_forbidden",
            );
        },
    };
}
