// Manual Actions experiment: no shared Claude credential, browser key or personal history is read.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { restoreCache } from "@actions/cache";
import { runAgentCommand } from "../src/runner/agent-process.ts";
import { historyArchivePath } from "../src/runner/context.ts";
import { restoreHistory, saveHistory } from "../src/runner/history-archive.ts";
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
        console.error(JSON.stringify({ event: "checkpoint.probe", stage: "failed", code: toAppError(error).code }));
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
    const cache = createActionsHistoryCache(context, process.env, (record) => console.error(JSON.stringify(record)));
    const large = process.env.EZSHARE_PROBE_LARGE_ARCHIVE === "true";
    const signal = AbortSignal.timeout((large ? 12 : 4) * 60_000);
    const synthetic = large ? await largeArchive(context, archive, signal) : null;
    try {
        await mkdir(dirname(archive), { recursive: true });
        if (synthetic === null) {
            await writeFile(archive, randomBytes(1024), { mode: 0o600 });
        }
        const expectedHash = await sha256(archive, signal);
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
        if ((await sha256(archive, signal)) !== expectedHash) {
            throw new Error("Cache round trip did not restore the synthetic snapshot");
        }
        if (synthetic !== null) {
            await synthetic.verify();
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

async function sha256(path, signal) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal })) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

async function largeArchive(context, archive, signal) {
    const account = { user: userInfo().username, home: join(context.runnerTemp, "agent") };
    const workspace = join(account.home, "workspace");
    const file = join(workspace, "synthetic.bin");
    const path = process.env.PATH;
    const bytes = 520 * 1024 * 1024;
    const personalKey = randomBytes(32).toString("base64url");
    const sessionId = crypto.randomUUID();

    await mkdir(workspace, { recursive: true });
    await pipeline(createReadStream("/dev/urandom", { end: bytes - 1 }), createWriteStream(file), { signal });
    const expected = await sha256(file, signal);
    await saveHistory(archive, personalKey, context, account, path, sessionId, signal);
    if ((await stat(archive)).size <= 512 * 1024 * 1024) {
        throw new Error("Synthetic archive did not exceed the previous limit");
    }
    await rm(file);
    console.log(JSON.stringify({ event: "checkpoint.probe", stage: "large_archive_created" }));
    return {
        verify: async () => {
            const restored = await restoreHistory(archive, personalKey, context, account, path, signal);
            if (
                restored.kind !== "restored" ||
                restored.sessionId !== sessionId ||
                (await sha256(file, signal)) !== expected
            ) {
                throw new Error("Encrypted archive did not restore the synthetic workspace");
            }
        },
    };
}
