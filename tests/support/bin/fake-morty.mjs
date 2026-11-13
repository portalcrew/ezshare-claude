// Controlled stand-in for the Morty CLI at its process boundary: `setup` NDJSON output and `stop`.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = join(process.env.HOME ?? "/nonexistent", "agent-env.jsonl");
appendFileSync(
    log,
    `${JSON.stringify({ program: "morty", command: args[0], names: Object.keys(process.env).sort() })}\n`,
);
const value = (name) => args[args.indexOf(name) + 1];

if (args[0] === "setup") {
    const url = new URL("https://morty.build/continue");
    url.searchParams.set("harness", "claude");
    url.searchParams.set("sessionId", value("--session-id"));
    url.searchParams.set("workspace", value("--cwd"));
    url.hash = "code=private-transfer-code";
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
