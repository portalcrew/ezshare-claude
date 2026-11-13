import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareChannelKey } from "../../src/runner/channel-key.ts";
import { runChat } from "../../src/runner/chat.ts";
import { historyArchivePath, readActionsContext } from "../../src/runner/context.ts";
import type { DiagnosticRecord } from "../../src/runner/diagnostics.ts";
import { runLogin } from "../../src/runner/login.ts";
import { toAppError } from "../../src/shared/errors.ts";
import { ACTIONS_BOT, type FakeGitHub, type FakeRun } from "./fake-github.ts";
import type { TestClock } from "./test-clock.ts";

const FIXTURES = join(import.meta.dirname, "bin");

export interface Job {
    readonly run: FakeRun;
    readonly agentHome: string;
    readonly diagnostics: DiagnosticRecord[];
    readonly done: Promise<void>;
    error: string | null;
}

/**
 * Executes dispatched session workflows the way their YAML does: prepare the channel key, publish the artifact,
 * then run the production session step in-process with the shared test clock. Agent programs are controlled
 * executables reached through a controlled sudo that resets the environment.
 */
export async function startFakeActions(
    github: FakeGitHub,
    options: { readonly repository: string; readonly clock: TestClock; readonly sharedToken: () => string | null },
) {
    const root = await mkdtemp(join(tmpdir(), "ezshare-actions-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const [name, script] of [
        ["sudo", "fake-sudo.mjs"],
        ["claude", "fake-claude.mjs"],
        ["morty", "fake-morty.mjs"],
    ] as const) {
        await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, script)}" "$@"\n`);
        await chmod(join(bin, name), 0o755);
    }
    const jobs = new Map<number, Job>();
    // The Actions cache of the default branch: entry key -> directory, in creation order.
    const cache = new Map<string, string>();
    let hold = false;
    const queued: FakeRun[] = [];

    const execute = async (run: FakeRun, job: { agentHome: string; diagnostics: DiagnosticRecord[] }) => {
        const purpose = run.workflow === "chat.yml" ? "chat" : "login";
        const directory = join(root, `run-${run.id}`);
        const runnerTemp = join(directory, "temp");
        await mkdir(runnerTemp, { recursive: true });
        // Every run is a fresh VM whose agent account has the same home path, which Claude's project names use.
        await rm(job.agentHome, { recursive: true, force: true });
        await rm(`${job.agentHome}.agent-env.jsonl`, { force: true });
        await mkdir(join(job.agentHome, "workspace"), { recursive: true });
        const output = join(directory, "github-output");
        await writeFile(output, "");
        const historyDirectory = join(runnerTemp, "ezshare-history");
        const cacheKey = `ezshare-history-${run.actor.id}-run-${run.id}`;
        if (purpose === "chat") {
            // actions/cache/restore: the exact key, else the newest entry under the prefix.
            const prefix = `ezshare-history-${run.actor.id}-run-`;
            const hit = cache.get(cacheKey) ?? [...cache].reverse().find(([key]) => key.startsWith(prefix))?.[1];
            if (hit !== undefined) {
                await cp(hit, historyDirectory, { recursive: true });
            }
        }
        const eventPath = join(directory, "event.json");
        await writeFile(eventPath, JSON.stringify({ inputs: run.inputs }));
        run.status = "in_progress";
        await prepareChannelKey(runnerTemp, output);
        const artifact = /^artifact-name=(.+)$/mu.exec(await readFile(output, "utf8"))?.[1];
        if (artifact !== undefined) {
            run.artifacts.push(artifact);
        }
        const token = `ghs_run_${run.id}`;
        github.grant(token, { user: ACTIONS_BOT, secrets: false, actions: false });
        const shared = options.sharedToken();
        const environment = {
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_RUN_ID: String(run.id),
            GITHUB_ACTOR_ID: String(run.actor.id),
            GITHUB_REPOSITORY: options.repository,
            GITHUB_REF: "refs/heads/main",
            GITHUB_WORKFLOW_REF: `${options.repository}/.github/workflows/${run.workflow}@refs/heads/main`,
            GITHUB_API_URL: github.origin,
            GITHUB_OUTPUT: output,
            GH_TOKEN: token,
            RUNNER_TEMP: runnerTemp,
            EZSHARE_AGENT_USER: "ezshare-agent",
            EZSHARE_AGENT_HOME: job.agentHome,
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            ...(purpose === "chat" && shared !== null ? { EZSHARE_CLAUDE_TOKEN: shared } : {}),
        };
        const ports = { clock: options.clock, diagnostics: (record: DiagnosticRecord) => job.diagnostics.push(record) };
        const context = await readActionsContext(environment, purpose, run.cancel.signal);
        try {
            await (purpose === "chat" ? runChat : runLogin)(context, environment, ports, run.cancel.signal);
        } finally {
            await cp(`${job.agentHome}.agent-env.jsonl`, join(directory, "agent-env.jsonl")).catch(() => undefined);
            // actions/cache/save, `if: always() && steps.serve.outputs.history == 'archived'`; entries are immutable.
            if (/^history=archived$/mu.test(await readFile(output, "utf8")) && !cache.has(cacheKey)) {
                const saved = join(root, "cache", cacheKey);
                await cp(historyDirectory, saved, { recursive: true });
                cache.set(cacheKey, saved);
            }
        }
        if (historyArchivePath(runnerTemp) !== join(historyDirectory, "history.bin")) {
            throw new Error("The simulated cache path must match chat.yml");
        }
    };

    const start = (run: FakeRun) => {
        if (run.status === "completed") {
            return;
        }
        const agentHome = join(root, `agent-${run.actor.id}`);
        const diagnostics: DiagnosticRecord[] = [];
        const job: Job = {
            run,
            agentHome,
            diagnostics,
            error: null,
            done: execute(run, { agentHome, diagnostics }).then(
                () => {
                    if (run.status !== "completed") {
                        run.status = "completed";
                        run.conclusion = "success";
                    }
                },
                (cause: unknown) => {
                    job.error = toAppError(cause).code;
                    if (run.status !== "completed") {
                        run.status = "completed";
                        run.conclusion = "failure";
                    }
                },
            ),
        };
        jobs.set(run.id, job);
    };

    github.onDispatch((run) => {
        if (hold) {
            queued.push(run);
        } else {
            start(run);
        }
    });

    return {
        jobs,
        /** Keeps dispatched runs queued until `release`. */
        holdQueue: () => {
            hold = true;
        },
        release: () => {
            hold = false;
            for (const run of queued.splice(0)) {
                start(run);
            }
        },
        /** Saved cache entries by key, as the repository's Actions cache would list them. */
        cache,
        /** Starts a run directly, as if dispatched by `run.actor` with arbitrary inputs. */
        start,
        agentLog: async (runId: number) => {
            const job = jobs.get(runId);
            // A finished run's log is kept with the run; a running one is read live.
            const text =
                job === undefined
                    ? ""
                    : await readFile(join(root, `run-${runId}`, "agent-env.jsonl"), "utf8").catch(() =>
                          readFile(`${job.agentHome}.agent-env.jsonl`, "utf8").catch(() => ""),
                      );
            return text
                .split("\n")
                .filter((line) => line.length > 0)
                .map((line): { program: string; command: string; names: string[] } => JSON.parse(line));
        },
        close: async () => {
            for (const job of jobs.values()) {
                job.run.cancel.abort(new DOMException("Test finished", "AbortError"));
            }
            await Promise.allSettled([...jobs.values()].map((job) => job.done));
            await rm(root, { recursive: true, force: true });
        },
    };
}
