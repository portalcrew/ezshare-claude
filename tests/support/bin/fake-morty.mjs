// Controlled stand-in for npx executing the current Morty CLI: setup NDJSON output and stop.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const invocation = process.argv.slice(2);
if (invocation[0] !== "--yes" || invocation[1] !== "@morty-build/cli@latest") {
    console.error("Expected npx to execute the latest Morty CLI");
    process.exit(2);
}
const args = invocation.slice(2);
const log = `${process.env.HOME ?? "/nonexistent"}.agent-env.jsonl`;
appendFileSync(
    log,
    `${JSON.stringify({ program: "npx", package: invocation[1], command: args[0], names: Object.keys(process.env).sort() })}\n`,
);
const value = (name) => args[args.indexOf(name) + 1];

if (args[0] === "setup") {
    if (existsSync(join(process.env.HOME, ".morty-failure"))) {
        console.log(
            JSON.stringify({
                error: {
                    code: "INVALID_REQUEST",
                    message: "private-provider-detail",
                    url: "https://morty.build/continue#code=private-code",
                },
            }),
        );
        process.exit(1);
    }
    // The member's conversation continues in the Claude session Morty attaches to; record that it was found.
    const project = join(process.env.HOME, ".claude", "projects", value("--cwd").replaceAll(/[^A-Za-z0-9]/gu, "-"));
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
            e2e: "opaque-morty-encryption-access",
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
