import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as v from "valibot";
import { decodeBase64Url } from "../shared/base64url.ts";
import { AppError } from "../shared/errors.ts";
import { parseJson, requestIdSchema } from "../shared/protocol.ts";
import { type AgentCommand, agentCommand } from "./agent-process.ts";
import type { AgentAccount } from "./context.ts";

/**
 * A member's history between sessions: the agent account's home (Claude's sessions and settings, and the
 * workspace), archived by the agent itself and encrypted by the step under a key only the member's browser keeps.
 *
 * File: MAGIC | nonce (12) | AES-256-GCM(manifest line + "\n" + tar.gz) | tag (16). The associated data binds the
 * archive to the repository and the member, so an archive never opens for another member or repository. Actions
 * caches are readable by every run on the default branch; this encryption is what keeps the history private.
 */

const MAGIC = Buffer.from("EZH1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
const TAR_TIMEOUT_MS = 5 * 60_000;

/** The parts of the agent's home that never travel: credentials, caches, and Morty's device identity. */
const EXCLUDED = ["./.claude/.credentials.json", "./.cache", "./.npm", "./morty", "node_modules"] as const;

const manifestSchema = v.strictObject({ version: v.literal(1), sessionId: requestIdSchema });

export interface HistoryOwner {
    readonly repository: string;
    readonly userId: string;
}

export type RestoredHistory =
    | { readonly kind: "none" }
    | { readonly kind: "unreadable" }
    | { readonly kind: "restored"; readonly sessionId: string };

function associatedData(owner: HistoryOwner): Buffer {
    return Buffer.from(JSON.stringify(["ezshare-history/v1", owner.repository, owner.userId]));
}

function historyKey(key: string): Buffer {
    const bytes = Buffer.from(decodeBase64Url(key));
    if (bytes.length !== 32) {
        throw new AppError("invalid_input");
    }
    return bytes;
}

/**
 * Opens the archive restored by the cache step, if any, and unpacks it into the agent's home as the agent.
 * The plaintext is written to a private file and unpacked only after its tag verified.
 */
export async function restoreHistory(
    archive: string,
    key: string,
    owner: HistoryOwner,
    account: AgentAccount,
    path: string,
    signal: AbortSignal,
): Promise<RestoredHistory> {
    const size = await stat(archive).then(
        (info) => (info.isFile() ? info.size : -1),
        () => -1,
    );
    if (size < 0) {
        return { kind: "none" };
    }
    if (size < MAGIC.length + NONCE_BYTES + TAG_BYTES || size > MAX_ARCHIVE_BYTES) {
        return { kind: "unreadable" };
    }
    const plain = join(dirname(archive), "history.plain");
    try {
        const header = Buffer.alloc(MAGIC.length + NONCE_BYTES);
        const tag = Buffer.alloc(TAG_BYTES);
        const handle = await open(archive, "r");
        try {
            await handle.read(header, 0, header.length, 0);
            await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
        } finally {
            await handle.close();
        }
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            return { kind: "unreadable" };
        }
        const decipher = createDecipheriv("aes-256-gcm", historyKey(key), header.subarray(MAGIC.length), {
            authTagLength: TAG_BYTES,
        });
        decipher.setAAD(associatedData(owner));
        decipher.setAuthTag(tag);
        try {
            await pipeline(
                createReadStream(archive, { start: header.length, end: size - TAG_BYTES - 1, signal }),
                decipher,
                createWriteStream(plain, { mode: 0o600, flags: "wx" }),
            );
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            // A wrong key, another member's archive or a modified file all fail authentication alike.
            return { kind: "unreadable" };
        }
        const { manifest, offset } = await readManifest(plain);
        await streamAgentCommand(
            await agentCommand(
                account,
                path,
                account.home,
                "tar",
                ["--extract", "--gzip", "--no-same-owner", "--file=-"],
                {},
            ),
            { input: createReadStream(plain, { start: offset }), signal },
        );
        return { kind: "restored", sessionId: manifest.sessionId };
    } finally {
        await rm(plain, { force: true });
    }
}

async function readManifest(plain: string) {
    const handle = await open(plain, "r");
    try {
        const head = Buffer.alloc(MAX_MANIFEST_BYTES);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const end = head.subarray(0, bytesRead).indexOf(0x0a);
        if (end < 0) {
            throw new AppError("invalid_response");
        }
        const manifest = v.safeParse(manifestSchema, parseJson(head.subarray(0, end).toString("utf8")));
        if (!manifest.success) {
            throw new AppError("invalid_response");
        }
        return { manifest: manifest.output, offset: end + 1 };
    } finally {
        await handle.close();
    }
}

/**
 * Archives the agent's home, as the agent, into `archive`. The previous file is replaced only once the new one
 * is complete, so a failed save leaves the restored archive (and the cache) as they were.
 */
export async function saveHistory(
    archive: string,
    key: string,
    owner: HistoryOwner,
    account: AgentAccount,
    path: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<void> {
    await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    try {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", historyKey(key), nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(associatedData(owner));
        const manifest = Buffer.from(`${JSON.stringify({ version: 1, sessionId })}\n`);
        let bytes = 0;
        let started = false;
        const begin = (): Buffer => {
            started = true;
            return Buffer.concat([MAGIC, nonce, cipher.update(manifest)]);
        };
        const seal = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > MAX_ARCHIVE_BYTES) {
                    callback(new AppError("invalid_input"));
                    return;
                }
                const head = started ? Buffer.alloc(0) : begin();
                callback(null, Buffer.concat([head, cipher.update(chunk)]));
            },
            flush(callback) {
                const head = started ? Buffer.alloc(0) : begin();
                callback(null, Buffer.concat([head, cipher.final(), cipher.getAuthTag()]));
            },
        });
        const tar = await agentCommand(
            account,
            path,
            account.home,
            "tar",
            ["--create", "--gzip", "--file=-", ...EXCLUDED.map((name) => `--exclude=${name}`), "."],
            {},
        );
        const [archived, written] = await Promise.allSettled([
            streamAgentCommand(tar, { output: seal, signal, acceptExitCodes: [0, 1] }),
            pipeline(seal, createWriteStream(partial, { mode: 0o600, flags: "wx" })),
        ]);
        if (archived.status === "rejected") {
            throw archived.reason;
        }
        if (written.status === "rejected") {
            throw written.reason;
        }
        await rename(partial, archive);
    } finally {
        await rm(partial, { force: true });
    }
}

/**
 * Finds the agent's most recently written Claude session in the workspace project, so the next session continues
 * the conversation the member saw last even if the harness moved to a new session.
 */
export async function latestSessionId(
    account: AgentAccount,
    path: string,
    workspace: string,
    fallback: string,
    signal: AbortSignal,
): Promise<string> {
    const project = join(".claude", "projects", workspace.replaceAll(/[^A-Za-z0-9]/gu, "-"));
    const chunks: Buffer[] = [];
    const collect = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
        },
    });
    try {
        await streamAgentCommand(await agentCommand(account, path, account.home, "ls", ["-t", project], {}), {
            output: collect,
            signal,
        });
    } catch {
        return fallback;
    }
    for (const name of Buffer.concat(chunks).toString("utf8").split("\n")) {
        const id = name.trim().replace(/\.jsonl$/u, "");
        if (name.trim().endsWith(".jsonl") && v.is(requestIdSchema, id)) {
            return id;
        }
    }
    return fallback;
}

/** Runs an agent command with streamed standard input or output. */
function streamAgentCommand(
    command: AgentCommand,
    options: {
        readonly input?: NodeJS.ReadableStream;
        readonly output?: NodeJS.WritableStream;
        readonly signal: AbortSignal;
        readonly acceptExitCodes?: readonly number[];
    },
): Promise<void> {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(TAR_TIMEOUT_MS)]);
    return new Promise((resolve, reject) => {
        const child = spawn(command.command, [...command.args], {
            cwd: "/",
            env: command.env,
            signal,
            killSignal: "SIGTERM",
            stdio: [
                options.input === undefined ? "ignore" : "pipe",
                options.output === undefined ? "ignore" : "pipe",
                "ignore",
            ],
        });
        let failure: unknown = null;
        if (options.input !== undefined && child.stdin !== null) {
            child.stdin.on("error", () => {
                /* The exit status reports the failure. */
            });
            options.input.on("error", (cause) => {
                failure = cause;
                child.kill("SIGTERM");
            });
            options.input.pipe(child.stdin);
        }
        if (options.output !== undefined && child.stdout !== null) {
            child.stdout.pipe(options.output);
            options.output.on("error", (cause) => {
                failure = cause;
                child.kill("SIGTERM");
            });
        }
        child.once("error", (cause) => reject(signal.aborted ? cause : new AppError("agent_failed", { cause })));
        child.once("close", (code) => {
            if (failure !== null) {
                reject(failure instanceof AppError ? failure : new AppError("agent_failed", { cause: failure }));
            } else if (code !== null && (options.acceptExitCodes ?? [0]).includes(code)) {
                resolve();
            } else {
                reject(new AppError("agent_failed"));
            }
        });
    });
}
