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
const log = `${process.env.HOME ?? "/nonexistent"}.agent-env.jsonl`;
appendFileSync(
    log,
    `${JSON.stringify({ program: "npx", package: invocation[3], command: args[0], names: Object.keys(process.env).sort(), configHome: process.env.XDG_CONFIG_HOME ?? null })}\n`,
);
const value = (name) => args[args.indexOf(name) + 1];

if (args[0] === "setup") {
    if (existsSync(join(process.env.HOME, ".morty-failure"))) {
        const failure = readFileSync(join(process.env.HOME, ".morty-failure"), "utf8");
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
                    code: failure === "computer-conflict" ? "COMPUTER_CONFLICT" : "INVALID_REQUEST",
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
    const url = new URL("https://morty.build/continue");
    url.searchParams.set("harness", "claude");
    url.searchParams.set("sessionId", value("--session-id"));
    if (existsSync(join(process.env.HOME, ".morty-legacy-handoff"))) {
        url.searchParams.set("workspace", value("--cwd"));
        url.hash = "code=private-transfer-code";
    } else {
        url.hash = new URLSearchParams({
            code: "private-transfer-code",
            workspace: value("--cwd"),
            e2e: Buffer.from(JSON.stringify(identity)).toString("base64url"),
        }).toString();
    }
    if (existsSync(join(process.env.HOME, ".morty-conflicting-handoff"))) {
        url.searchParams.set("workspace", "/another-member/workspace");
    }
    console.log(JSON.stringify({ status: "computer_online" }));
    console.log(JSON.stringify({ status: "ready", url: url.href, accessExpiresAt: "2026-11-13T09:00:00.000Z" }));
    process.exit(0);
}
if (args[0] === "stop") {
    console.log("Stopped");
    process.exit(0);
}
console.error(`fake morty: unexpected arguments ${JSON.stringify(args)}`);
process.exit(2);
