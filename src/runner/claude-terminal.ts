import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import xterm from "@xterm/headless";
import * as v from "valibot";
import { withDeadline } from "../shared/async.ts";
import { AppError } from "../shared/errors.ts";
import { authorizationCodeSchema, authorizationUrl, claudeTokenSchema } from "../shared/protocol.ts";
import type { AgentCommand } from "./agent-process.ts";

const COLUMNS = 1000;
const ROWS = 80;
const MAX_OUTPUT_BYTES = 2_000_000;

type TerminalState =
    | { readonly kind: "running" }
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: AppError };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Drives `claude setup-token` in a pseudo-terminal and reads its rendered screen, because the official CLI
 * prints the authorization link and the token only to an interactive terminal.
 */
export class ClaudeTerminal {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #screen = new xterm.Terminal({ cols: COLUMNS, rows: ROWS, scrollback: 100, allowProposedApi: true });
    readonly #changes = new EventEmitter();
    readonly #closed: Promise<void>;
    #state: TerminalState = { kind: "running" };
    #rendering: Promise<void> = Promise.resolve();
    #bytes = 0;

    constructor(command: AgentCommand) {
        const shell = `stty cols ${COLUMNS} rows ${ROWS}; exec ${[command.command, ...command.args].map(quote).join(" ")}`;
        try {
            this.#child = spawn("script", ["-qefc", shell, "/dev/null"], { cwd: "/", env: command.env });
        } catch (cause) {
            this.#screen.dispose();
            throw new AppError("provider_failed", { cause });
        }
        this.#child.stdin.on("error", () => {
            /* The process may exit before reading input; the state change reports it. */
        });
        this.#closed = new Promise((resolve) => {
            this.#child.once("error", (cause) => {
                this.#state = { kind: "failed", error: new AppError("provider_failed", { cause }) };
                this.#changes.emit("change");
                resolve();
            });
            this.#child.once("close", () => {
                void this.#rendering.finally(() => {
                    if (this.#state.kind === "running") {
                        this.#state = { kind: "closed" };
                    }
                    this.#changes.emit("change");
                    resolve();
                });
            });
        });
        const consume = (chunk: Buffer) => {
            this.#bytes += chunk.byteLength;
            if (this.#bytes > MAX_OUTPUT_BYTES) {
                this.#state = { kind: "failed", error: new AppError("provider_failed") };
                this.#changes.emit("change");
                this.#child.kill("SIGTERM");
                return;
            }
            this.#rendering = this.#rendering.then(
                () =>
                    new Promise<void>((resolve) => {
                        this.#screen.write(chunk, () => {
                            this.#changes.emit("change");
                            resolve();
                        });
                    }),
            );
        };
        this.#child.stdout.on("data", consume);
        this.#child.stderr.on("data", consume);
    }

    readonly #text = (): string => {
        const buffer = this.#screen.buffer.active;
        const lines: string[] = [];
        for (let index = 0; index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
        }
        return lines.join("\n");
    };

    /** Resolves when `find` recognizes the screen; fails if the process ends first or the signal aborts. */
    readonly #find = <T>(find: (text: string) => T | undefined, signal: AbortSignal): Promise<T> =>
        new Promise((resolve, reject) => {
            const dispose = () => {
                this.#changes.removeListener("change", changed);
                signal.removeEventListener("abort", aborted);
            };
            const aborted = () => {
                dispose();
                reject(new AppError("cancelled", { cause: signal.reason }));
            };
            const changed = () => {
                try {
                    if (signal.aborted) {
                        aborted();
                        return;
                    }
                    const found = find(this.#text());
                    if (found !== undefined) {
                        dispose();
                        resolve(found);
                        return;
                    }
                    switch (this.#state.kind) {
                        case "running":
                            return;
                        case "failed":
                            throw this.#state.error;
                        case "closed":
                            throw new AppError("provider_failed");
                        default:
                            return this.#state satisfies never;
                    }
                } catch (cause) {
                    dispose();
                    reject(cause);
                }
            };
            this.#changes.on("change", changed);
            signal.addEventListener("abort", aborted, { once: true });
            changed();
        });

    readonly authorization = (signal: AbortSignal): Promise<string> =>
        this.#find((text) => {
            const url = /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\S*/u.exec(text)?.[0];
            return url === undefined ? undefined : authorizationUrl(url);
        }, signal);

    /** Enters the code, confirms the CLI echoed it, submits it and reads the token block. */
    readonly complete = async (code: string, signal: AbortSignal): Promise<string> => {
        if (!v.is(authorizationCodeSchema, code)) {
            throw new AppError("invalid_input");
        }
        this.#child.stdin.write(code);
        const masked = `${"*".repeat(Math.max(0, code.length - 6))}${code.slice(-6)}`;
        await withDeadline(10_000, signal, (bounded) =>
            this.#find((text) => {
                const joined = text.replaceAll("\n", "");
                return joined.includes(code) || joined.includes(masked) ? true : undefined;
            }, bounded),
        );
        this.#child.stdin.write("\r");
        return this.#find((text) => {
            if (/OAuth error|[Ii]nvalid (?:code|grant)/u.test(text)) {
                throw new AppError("provider_failed");
            }
            const lines = text.split("\n");
            const start = lines.findIndex((line) => line.includes("valid for 1 year"));
            const end = lines.findIndex((line, index) => index > start && line.includes("Store this token"));
            if (start < 0 || end < 0) {
                return undefined;
            }
            const token = /sk-ant-oat01-[A-Za-z0-9_-]{20,2048}/u.exec(
                lines
                    .slice(start + 1, end)
                    .map((line) => line.trim())
                    .join(""),
            )?.[0];
            return token !== undefined && v.is(claudeTokenSchema, token) ? token : undefined;
        }, signal);
    };

    readonly dispose = async (): Promise<void> => {
        this.#child.kill("SIGTERM");
        const timer = setTimeout(() => this.#child.kill("SIGKILL"), 3000);
        try {
            await this.#closed;
        } finally {
            clearTimeout(timer);
            this.#changes.removeAllListeners();
            this.#screen.dispose();
        }
    };
}
