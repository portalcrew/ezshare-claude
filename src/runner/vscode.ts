import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import { type Clock, cleanupSignal, withDeadline } from "../shared/async.ts";
import { AppError } from "../shared/errors.ts";
import { VSCODE_DESKTOP_WORKSPACE, vscodeDeviceCodeSchema, vscodeUrl } from "../shared/protocol.ts";
import { type AgentCommand, agentCommand, runAgentCommand } from "./agent-process.ts";
import { type ActionsContext, agentWorkspace } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { ChatRunnerChannel } from "./session.ts";

type Progress =
    | { readonly kind: "starting" }
    | { readonly kind: "authorizing"; readonly code: string }
    | { readonly kind: "ready"; readonly url: string };

export class VscodeSession {
    readonly #context: ActionsContext;
    readonly #path: string;
    readonly #variables: Readonly<Record<string, string>>;
    readonly #clock: Clock;
    readonly #claudeVariables: Readonly<Record<string, string>>;
    readonly #diagnostics: Diagnostics;
    readonly #name: string;
    #process: TunnelProcess | null = null;
    #progress: Progress = { kind: "starting" };

    constructor(context: ActionsContext, path: string, token: string, clock: Clock, diagnostics: Diagnostics) {
        this.#context = context;
        this.#path = path;
        this.#clock = clock;
        this.#diagnostics = diagnostics;
        this.#name =
            "ez-" +
            createHash("sha256")
                .update(`${context.repository.toLowerCase()}:${context.userId}`)
                .digest("hex")
                .slice(0, 16);
        this.#claudeVariables = {
            SHELL: "/bin/bash",
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_OAUTH_TOKEN: token,
        };
        this.#variables = {
            TERM: "xterm-256color",
            BROWSER: "false",
            NO_BROWSER: "1",
            VSCODE_CLI_USE_FILE_KEYCHAIN: "1",
            VSCODE_CLI_DATA_DIR: join(context.agent.home, "vscode", "cli"),
        };
    }

    readonly connect = async (
        channel: ChatRunnerChannel,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "ready"; readonly url: string } | { readonly kind: "stopped" }> => {
        await this.prepareWorkspace(signal);
        this.#diagnostics({ event: "vscode.stage", stage: "checking_authorization" });
        let exitCode: number | null = null;
        try {
            await runAgentCommand(await this.command(["tunnel", "user", "show"]), {
                timeout: 30_000,
                failure: "vscode_unavailable",
                signal,
                onFailure: (result) => {
                    exitCode = result.exitCode;
                },
            });
        } catch (cause) {
            if (signal.aborted || exitCode !== 1) {
                throw cause;
            }
            this.#diagnostics({ event: "vscode.stage", stage: "authorizing" });
            if (!(await this.runStage(["tunnel", "user", "login", "--provider", "github"], "exit", channel, signal))) {
                return { kind: "stopped" };
            }
        }
        this.#progress = { kind: "starting" };
        this.#diagnostics({ event: "vscode.stage", stage: "starting_tunnel" });
        if (
            !(await this.runStage(
                [
                    "tunnel",
                    "--accept-server-license-terms",
                    "--install-extension",
                    "anthropic.claude-code",
                    "--name",
                    this.#name,
                    "--extensions-dir",
                    join(this.#context.agent.home, "vscode", "extensions"),
                    "--server-data-dir",
                    join(this.#context.agent.home, "vscode", "server"),
                    "--reconnection-grace-time",
                    "0",
                ],
                "link",
                channel,
                signal,
            ))
        ) {
            return { kind: "stopped" };
        }
        const progress = this.progress();
        if (progress.kind !== "ready") {
            throw new AppError("vscode_unavailable");
        }
        return { kind: "ready", url: progress.url };
    };

    readonly assertRunning = (): void => {
        const status = this.#process?.status();
        if (status === undefined || status.kind === "exited") {
            this.#diagnostics({ event: "vscode.failed", stage: "connection", exitCode: status?.code ?? null });
            throw new AppError("vscode_unavailable", { cause: status?.cause });
        }
    };

    readonly stop = async (): Promise<void> => {
        try {
            await runAgentCommand(await this.command(["tunnel", "kill"]), {
                timeout: 15_000,
                failure: "vscode_unavailable",
                signal: cleanupSignal(20_000),
            });
        } catch {
            // A cancelled authorization has not started a tunnel.
        } finally {
            await this.#process?.stop();
            this.#process = null;
        }
    };

    private readonly progress = (): Progress => this.#progress;

    private readonly command = (args: readonly string[], serving = false) =>
        agentCommand(
            this.#context.agent,
            this.#path,
            agentWorkspace(this.#context.agent),
            "code",
            args,
            serving ? { ...this.#variables, ...this.#claudeVariables } : this.#variables,
        );

    private readonly runStage = async (
        args: readonly string[],
        until: "exit" | "link",
        channel: ChatRunnerChannel,
        signal: AbortSignal,
    ): Promise<boolean> =>
        withDeadline(
            until === "exit" ? 10 * 60_000 : 4 * 60_000,
            signal,
            async (bounded) => {
                const process = startProcess(await this.command(args, until === "link"), this.line);
                this.#process = process;
                let sentCode: string | null = null;
                for (;;) {
                    bounded.throwIfAborted();
                    if ((await channel.receive(bounded)).some((message) => message.kind === "stop")) {
                        return false;
                    }
                    const progress = this.#progress;
                    if (progress.kind === "authorizing" && progress.code !== sentCode) {
                        await channel.send({ kind: "vscode_challenge", body: { code: progress.code } }, bounded);
                        this.#diagnostics({ event: "vscode.stage", stage: "awaiting_authorization" });
                        sentCode = progress.code;
                    }
                    const status = process.status();
                    if (status.kind === "exited") {
                        if (until === "exit" && status.code === 0) {
                            await process.stop();
                            return true;
                        }
                        this.#diagnostics({
                            event: "vscode.failed",
                            stage: until === "exit" ? "authorization" : "connection",
                            exitCode: status.code,
                        });
                        throw new AppError("vscode_unavailable", { cause: status.cause });
                    }
                    if (until === "link" && progress.kind === "ready") {
                        this.#diagnostics({ event: "vscode.stage", stage: "ready" });
                        return true;
                    }
                    await this.#clock.sleep(3_000, bounded);
                }
            },
            this.#clock,
        );

    private readonly line = (line: string): void => {
        const challenge =
            /To grant access to the server, please log into https:\/\/github\.com\/login\/device and use code ([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/u.exec(
                line,
            );
        const code = challenge?.[1];
        if (v.is(vscodeDeviceCodeSchema, code)) {
            this.#progress = { kind: "authorizing", code };
        }
        const found = /https:\/\/vscode\.dev\/tunnel\/([a-zA-Z0-9-]+)(?:\/|\s|$)/u.exec(line);
        if (found?.[1] === this.#name) {
            const workspace = agentWorkspace(this.#context.agent).split("/").map(encodeURIComponent).join("/");
            this.#progress = { kind: "ready", url: vscodeUrl(`https://vscode.dev/tunnel/${this.#name}${workspace}`) };
        }
    };

    private readonly prepareWorkspace = async (signal: AbortSignal): Promise<void> => {
        const script = String.raw`
            const fs = require("node:fs");
            const path = require("node:path");
            // Regenerate our own workspace file; never replace the member's workspace settings.
            fs.writeFileSync(process.argv[2], JSON.stringify({
                folders: [{ path: process.argv[1] }],
                settings: {
                    "workbench.browser.enableRemoteProxy": true,
                    "workbench.browser.dataStorage": "workspace"
                }
            }, null, 2) + "\n", { mode: 384 });
            const file = path.join(process.argv[1], ".vscode", "settings.json");
            let settings;
            try {
                settings = JSON.parse(fs.readFileSync(file, "utf8"));
            } catch {
                // Leave missing files and user-authored JSONC untouched.
                process.exit(0);
            }
            if (settings === null || Array.isArray(settings) || typeof settings !== "object") process.exit(0);
            const profiles = settings["terminal.integrated.profiles.linux"];
            const profile = profiles?.["Ezshare Claude"];
            if (profile === null || typeof profile !== "object" ||
                !Array.isArray(profile.args) || profile.args.length !== 1 || profile.args[0] !== "--continue" ||
                typeof profile.path !== "string" || !profile.path.endsWith("/claude")) process.exit(0);
            delete profiles["Ezshare Claude"];
            if (Object.keys(profiles).length === 0) delete settings["terminal.integrated.profiles.linux"];
            if (settings["terminal.integrated.defaultProfile.linux"] === "Ezshare Claude") {
                delete settings["terminal.integrated.defaultProfile.linux"];
            }
            if (Object.keys(settings).length === 0) fs.unlinkSync(file);
            else fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
        `;
        await runAgentCommand(
            await agentCommand(
                this.#context.agent,
                this.#path,
                agentWorkspace(this.#context.agent),
                "node",
                [
                    "-e",
                    script,
                    agentWorkspace(this.#context.agent),
                    join(this.#context.agent.home, VSCODE_DESKTOP_WORKSPACE),
                ],
                {},
            ),
            { timeout: 15_000, failure: "vscode_unavailable", signal },
        );
    };
}

type ProcessStatus =
    | { readonly kind: "running" }
    | { readonly kind: "exited"; readonly code: number | null; readonly cause: unknown };

interface TunnelProcess {
    readonly status: () => ProcessStatus;
    readonly stop: () => Promise<void>;
}

function startProcess(command: AgentCommand, onLine: (line: string) => void): TunnelProcess {
    const child = spawn(command.command, [...command.args], { cwd: "/", env: command.env, stdio: "pipe" });
    child.stdin.end();
    let status: ProcessStatus = { kind: "running" };
    const closed = Promise.withResolvers<void>();
    let failure: unknown = null;
    const release = [child.stdout, child.stderr].map((stream) => {
        let pending = "";
        stream.setEncoding("utf8");
        const data = (chunk: string): void => {
            pending += chunk;
            for (;;) {
                const end = pending.indexOf("\n");
                if (end < 0) {
                    break;
                }
                const line = pending.slice(0, end).replace(/\r$/u, "");
                pending = pending.slice(end + 1);
                try {
                    if (line.length > 16_384) {
                        throw new AppError("vscode_unavailable");
                    }
                    onLine(line);
                } catch (cause) {
                    failure = cause;
                    child.kill("SIGTERM");
                }
            }
            if (pending.length > 16_384) {
                failure = new AppError("vscode_unavailable");
                pending = "";
                child.kill("SIGTERM");
            }
        };
        stream.on("data", data);
        return () => stream.removeListener("data", data);
    });
    child.once("error", (cause) => {
        failure = cause;
        status = { kind: "exited", code: null, cause };
        closed.resolve();
    });
    child.once("close", (code) => {
        status = { kind: "exited", code, cause: failure };
        closed.resolve();
    });
    const waitClosed = (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            const abort = () => {
                signal.removeEventListener("abort", abort);
                reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            closed.promise.then(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, reject);
            if (signal.aborted) {
                abort();
            }
        });
    return {
        status: (): ProcessStatus => status,
        stop: async (): Promise<void> => {
            if (status.kind === "running") {
                child.kill("SIGTERM");
            }
            try {
                await withDeadline(10_000, cleanupSignal(15_000), waitClosed);
            } catch {
                child.kill("SIGKILL");
                await withDeadline(5_000, cleanupSignal(6_000), waitClosed);
            } finally {
                for (const dispose of release) {
                    dispose();
                }
            }
        },
    };
}
