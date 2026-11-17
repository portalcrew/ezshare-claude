// Manual Actions experiment: no shared Claude credential, browser key or personal history is read.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreCache } from "@actions/cache";
import { runAgentCommand } from "../src/runner/agent-process.ts";
import { historyArchivePath } from "../src/runner/context.ts";
import { createActionsHistoryCache } from "../src/runner/history-cache.ts";
import { toAppError } from "../src/shared/errors.ts";

if (process.argv[2] === "restore") {
    try {
        if ((await restoreCache([process.argv[3]], process.argv[4])) !== process.argv[4]) {
            process.exitCode = 1;
        }
    } catch {
        process.exitCode = 1;
    }
} else {
    await probe().catch((error) => {
        let output = "";
        if (error instanceof Error && error.cause !== null && typeof error.cause === "object") {
            for (const name of ["stdout", "stderr"]) {
                if (typeof error.cause[name] === "string") {
                    output += error.cause[name];
                }
            }
        }
        const signals = [
            "ERR_MODULE_NOT_FOUND",
            "ERR_PACKAGE_PATH_NOT_EXPORTED",
            "EACCES",
            "ENOENT",
            "ACTIONS_RUNTIME_TOKEN",
            "ACTIONS_RESULTS_URL",
            "read-only",
            "Cache reservation failed",
            "Unable to reserve",
            "401",
            "403",
            "404",
            "tar failed",
            "TypeError",
            "ValidationError",
            "invalid_args",
            "not_committed",
            "exception",
        ].filter((code) => output.includes(code));
        console.error(
            JSON.stringify({
                event: "checkpoint.probe",
                stage: "failed",
                code: toAppError(error).code,
                signals,
                runtime: Boolean(process.env.ACTIONS_RUNTIME_TOKEN),
                endpoint: Boolean(process.env.ACTIONS_RESULTS_URL),
                outputBytes: output.length,
                exit:
                    error instanceof Error && error.cause && typeof error.cause.code === "number"
                        ? error.cause.code
                        : null,
            }),
        );
        process.exitCode = 1;
    });
}

async function probe() {
    const context = {
        userId: process.env.GITHUB_ACTOR_ID,
        runId: process.env.GITHUB_RUN_ID,
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        token: process.env.GH_TOKEN,
        apiOrigin: process.env.GITHUB_API_URL,
        // Different paths produce a distinct cache version, so even an abandoned probe cannot shadow personal history.
        runnerTemp: join(process.env.RUNNER_TEMP, "checkpoint-probe"),
    };
    const archive = historyArchivePath(context.runnerTemp);
    const key = `ezshare-history-${context.userId}-run-${context.runId}-checkpoint-${crypto.randomUUID()}`;
    const cache = createActionsHistoryCache(context, process.env);
    const bytes = randomBytes(1024);
    const signal = AbortSignal.timeout(4 * 60_000);
    try {
        await mkdir(dirname(archive), { recursive: true });
        await writeFile(archive, bytes, { mode: 0o600 });
        await cache.save(key, archive, signal);
        console.log(JSON.stringify({ event: "checkpoint.probe", stage: "uploaded" }));
        await rm(archive);
        await runAgentCommand(
            {
                command: "timeout",
                args: [
                    "--kill-after=5s",
                    "180s",
                    "node",
                    fileURLToPath(import.meta.url),
                    "restore",
                    dirname(archive),
                    key,
                ],
                env: Object.fromEntries(
                    Object.entries(process.env).filter(([name]) =>
                        [
                            "PATH",
                            "HOME",
                            "RUNNER_TEMP",
                            "GITHUB_WORKSPACE",
                            "GITHUB_REPOSITORY",
                            "GITHUB_REF",
                            "ACTIONS_RUNTIME_TOKEN",
                            "ACTIONS_CACHE_URL",
                            "ACTIONS_RESULTS_URL",
                            "ACTIONS_CACHE_SERVICE_V2",
                        ].includes(name),
                    ),
                ),
            },
            { timeout: 190_000, failure: "github_unavailable", signal },
        );
        if (!(await readFile(archive)).equals(bytes)) {
            throw new Error("Cache round trip did not restore the synthetic snapshot");
        }
        console.log(JSON.stringify({ event: "checkpoint.probe", stage: "restored" }));
    } finally {
        try {
            await cache.remove(key, AbortSignal.timeout(30_000));
            console.log(JSON.stringify({ event: "checkpoint.probe", stage: "removed" }));
        } catch (error) {
            console.error(
                JSON.stringify({ event: "checkpoint.probe", stage: "cleanup_failed", code: toAppError(error).code }),
            );
            process.exitCode = 1;
        }
    }
}
