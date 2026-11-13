import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { withDeadline } from "../shared/async.ts";
import { AppError, type ErrorCode } from "../shared/errors.ts";
import type { AgentAccount } from "./context.ts";

/** A command line with the environment its program may see, and nothing else. */
export interface AgentCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

/**
 * Builds a command that runs `program` as the agent account. sudo resets the environment, so only the listed
 * variables reach the agent; the step's GitHub token and channel key stay with the step's account.
 */
export async function agentCommand(
    account: AgentAccount,
    path: string,
    cwd: string,
    program: string,
    args: readonly string[],
    variables: Readonly<Record<string, string>>,
): Promise<AgentCommand> {
    const executable = await resolveExecutable(program, path);
    const env = { ...variables, HOME: account.home };
    for (const name of Object.keys(env)) {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || name === "PATH") {
            throw new AppError("invalid_input");
        }
    }
    return {
        command: "sudo",
        args: [
            "-n",
            "-u",
            account.user,
            `--preserve-env=${Object.keys(env).sort().join(",")}`,
            "--",
            // The step's account cannot enter the agent's home, so the agent changes directory itself.
            "/usr/bin/env",
            "-C",
            cwd,
            `PATH=${path}`,
            executable,
            ...args,
        ],
        env: { ...env, PATH: path },
    };
}

/** Runs a finite agent command and returns its standard output. Failures carry only the given code. */
export function runAgentCommand(
    command: AgentCommand,
    options: {
        readonly timeout: number;
        readonly failure: ErrorCode;
        readonly signal: AbortSignal;
    },
): Promise<string> {
    return withDeadline(
        options.timeout,
        options.signal,
        (signal) =>
            new Promise((resolve, reject) => {
                execFile(
                    command.command,
                    [...command.args],
                    { cwd: "/", env: command.env, signal, maxBuffer: 2_000_000, killSignal: "SIGTERM" },
                    (error, stdout) => {
                        if (error === null) {
                            resolve(stdout);
                        } else {
                            reject(signal.aborted ? error : new AppError(options.failure, { cause: error }));
                        }
                    },
                );
            }),
    );
}

async function resolveExecutable(program: string, path: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]*$/u.test(program)) {
        throw new AppError("invalid_input");
    }
    for (const directory of path.split(delimiter)) {
        if (!isAbsolute(directory)) {
            continue;
        }
        const candidate = join(directory, program);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            /* Not in this directory. */
        }
    }
    throw new AppError("agent_failed");
}
