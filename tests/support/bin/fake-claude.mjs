// Controlled stand-in for the Claude Code CLI at its process boundary: `-p` result JSON and the interactive
// `setup-token` screen. It records which environment variables reached it.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
appendFileSync(
    `${process.env.HOME ?? "/nonexistent"}.agent-env.jsonl`,
    `${JSON.stringify({ program: "claude", command: args[0], names: Object.keys(process.env).sort() })}\n`,
);
const value = (name) => args[args.indexOf(name) + 1];

if (args[0] === "setup-token") {
    process.stdout.write("Welcome to Claude Code\r\n");
    process.stdout.write(
        "Browse to: https://claude.ai/oauth/authorize?code=true&client_id=fake&state=fake-state&code_challenge=fake\r\n",
    );
    process.stdout.write("Paste code here if prompted > ");
    const lines = createInterface({ input: process.stdin });
    const code = await new Promise((resolve) => lines.once("line", resolve));
    lines.close();
    if (code.trim() === "wrong-code-0000") {
        process.stdout.write("\r\nOAuth error: invalid code\r\n");
        process.exit(1);
    }
    process.stdout.write("\r\nLong-lived authentication token created successfully!\r\n");
    process.stdout.write("Your OAuth token (valid for 1 year):\r\n\r\n");
    process.stdout.write(`sk-ant-oat01-${"S".repeat(24)}${code.trim().replace(/[^A-Za-z0-9_-]/gu, "")}\r\n\r\n`);
    process.stdout.write("Store this token securely. You won't be able to see it again.\r\n");
    process.exit(0);
}

if (args[0] === "-p") {
    if (!/^sk-ant-oat01-/u.test(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "")) {
        console.error("Not logged in");
        process.exit(1);
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN.includes("REVOKED")) {
        console.error("OAuth token revoked");
        process.exit(1);
    }
    // Like the real CLI, the session is a JSONL file in the project directory named after the working directory.
    const project = join(process.env.HOME, ".claude", "projects", process.cwd().replaceAll(/[^A-Za-z0-9]/gu, "-"));
    mkdirSync(project, { recursive: true });
    appendFileSync(
        join(project, `${value("--session-id")}.jsonl`),
        `${JSON.stringify({ type: "user", text: args[1] })}\n`,
    );
    console.log(
        JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "READY",
            session_id: value("--session-id"),
        }),
    );
    process.exit(0);
}

console.error(`fake claude: unexpected arguments ${JSON.stringify(args)}`);
process.exit(2);
