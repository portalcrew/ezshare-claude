import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
// Controlled stand-in for npx executing the current Morty CLI: setup NDJSON output and stop.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const invocation = process.argv.slice(2);
if (
    invocation[0] !== "--yes" ||
    invocation[1] !== "--prefer-online" ||
    invocation[2] !== "--json" ||
    invocation[3] !== "@portalcrew/morty@latest"
) {
    console.error("Expected npx to execute the latest Morty CLI");
    process.exit(2);
}
const args = invocation.slice(4);
const value = (name) => args[args.indexOf(name) + 1];
const log = `${process.env.HOME ?? "/nonexistent"}.agent-env.jsonl`;
appendFileSync(
    log,
    `${JSON.stringify({ program: "npx", package: invocation[3], command: args[0], sessionId: args[0] === "setup" ? value("--session-id") : null, names: Object.keys(process.env).sort(), configHome: process.env.XDG_CONFIG_HOME ?? null })}\n`,
);

if (args[0] === "setup") {
    if (existsSync(join(process.env.HOME, ".morty-failure"))) {
        const failure = readFileSync(join(process.env.HOME, ".morty-failure"), "utf8");
        if (failure === "runtime-revoked" || failure === "relay-transient" || failure === "relay-unavailable") {
            if (failure === "relay-transient") {
                unlinkSync(join(process.env.HOME, ".morty-failure"));
            }
            console.log(
                JSON.stringify({ status: "runtime_retrying", failure: { message: "private-provider-detail" } }),
            );
            console.log(
                JSON.stringify({
                    error: {
                        code: failure === "runtime-revoked" ? "RUNTIME_START_FAILED" : "RELAY_UNAVAILABLE",
                        message: "private-provider-detail",
                        cause: {
                            name: "RuntimeStartError",
                            code: "RUNTIME_START_FAILED",
                            cause: {
                                name: "ComputerPairingRevokedError",
                                code: failure === "runtime-revoked" ? "computer_pairing_revoked" : "ECONNRESET",
                                message: "https://morty.build/continue#code=private-code",
                                cause: { code: "private-code", message: "private-provider-detail" },
                            },
                        },
                    },
                }),
            );
            process.exit(1);
        }
        if (failure === "npm-text") {
            console.error(
                "npm error code EACCES\nnpm error private-provider-detail https://morty.build/continue#code=private-code",
            );
            process.exit(1);
        }
        if (failure === "node-module") {
            console.error(
                "Error [ERR_MODULE_NOT_FOUND]: private-provider-detail https://morty.build/continue#code=private-code",
            );
            process.exit(1);
        }
        if (failure === "unknown") {
            console.log(JSON.stringify({ error: { code: "private-code", message: "private-provider-detail" } }));
            process.exit(1);
        }
        if (["npm-transient", "npm-unavailable", "npm404-transient", "npm404-unavailable"].includes(failure)) {
            if (failure === "npm-transient" || failure === "npm404-transient") {
                unlinkSync(join(process.env.HOME, ".morty-failure"));
            }
            console.log(
                JSON.stringify(
                    {
                        error: {
                            code: failure.startsWith("npm404-") ? "E404" : "ETARGET",
                            summary: "private-workspace-detail",
                            detail: "private-code",
                        },
                    },
                    null,
                    2,
                ),
            );
            process.exit(1);
        }
        if (failure === "npm") {
            console.log(
                JSON.stringify(
                    {
                        error: {
                            code: "EJSONPARSE",
                            summary: "private-workspace-detail",
                            detail: "https://morty.build/continue#code=private-code",
                        },
                    },
                    null,
                    2,
                ),
            );
            process.exit(1);
        }
        console.error(
            JSON.stringify({
                error: {
                    code:
                        failure === "computer-revoked"
                            ? "computer_revoked"
                            : failure === "computer-conflict"
                              ? "COMPUTER_CONFLICT"
                              : "INVALID_REQUEST",
                    message: "private-provider-detail",
                    url: "https://morty.build/continue#code=private-code",
                },
            }),
        );
        process.exit(1);
    }
    const state = process.env.MORTY_STATE_DIRECTORY;
    mkdirSync(join(state, "computer", "sessions"), { recursive: true });
    const identityFile = join(state, "config.json");
    const identity = existsSync(identityFile)
        ? JSON.parse(readFileSync(identityFile, "utf8"))
        : { computerId: crypto.randomUUID(), computerE2EAccessSecret: "fake-private-computer-key" };
    if (identity.revoked === true) {
        console.log(JSON.stringify({ status: "checking_computer" }));
        console.error(
            JSON.stringify({ error: { code: "computer_revoked", message: "The Computer has been revoked" } }),
        );
        process.exit(1);
    }
    writeFileSync(identityFile, JSON.stringify(identity));
    appendFileSync(
        join(state, "computer", "sessions", "events.jsonl"),
        `${JSON.stringify({ text: "turn via morty" })}\n`,
    );
    // The member's conversation continues in the Claude session Morty attaches to; record that it was found.
    const project = join(
        process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude"),
        "projects",
        value("--cwd").replaceAll(/[^A-Za-z0-9]/gu, "-"),
    );
    const session = join(project, `${value("--session-id")}.jsonl`);
    if (!existsSync(session)) {
        console.error("fake morty: no such Claude session");
        process.exit(1);
    }
    appendFileSync(session, `${JSON.stringify({ type: "assistant", text: "turn via morty" })}\n`);
    writeFileSync(join(process.env.HOME, "workspace", "notes.txt"), "kept between sessions\n", { flag: "a" });
    const computerId = identity.computerId;
    const secret = randomBytes(16);
    const derive = (purpose, length) =>
        Buffer.from(hkdfSync("sha256", secret, "", `morty setup handoff v1 ${purpose}`, length));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derive("key", 32), iv);
    cipher.setAAD(Buffer.from(`morty setup handoff v1\0${computerId}`));
    const workspace = value("--cwd");
    const plaintext = JSON.stringify({
        version: 1,
        code: "private-transfer-code",
        encryption: JSON.stringify({ computerId }),
        harness: "claude",
        sessionId: value("--session-id"),
        workspace: existsSync(join(process.env.HOME, ".morty-conflicting-handoff"))
            ? "/another-member/workspace"
            : workspace,
    });
    const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString(
        "base64url",
    );
    writeFileSync(
        join(process.env.HOME, `.handoff-${computerId}-${derive("lookup", 16).toString("base64url")}`),
        sealed,
    );
    const url = `https://morty.build/continue#h=${computerId}.${secret.toString("base64url")}`;
    console.log(JSON.stringify({ status: "computer_online" }));
    console.log(
        JSON.stringify({ status: "ready", url, computerId, workspace, accessExpiresAt: "2026-11-13T09:00:00.000Z" }),
    );
    process.exit(0);
}
if (args[0] === "stop") {
    console.log("Stopped");
    process.exit(0);
}
console.error(`fake morty: unexpected arguments ${JSON.stringify(args)}`);
process.exit(2);
