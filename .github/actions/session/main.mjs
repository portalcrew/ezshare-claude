import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// JavaScript actions receive the cache runtime credentials; ordinary shell steps do not.
const child = spawn("node", [fileURLToPath(new URL("../../../src/runner/main.ts", import.meta.url)), "chat"], {
    stdio: "inherit",
    env: process.env,
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
    process.exitCode = await new Promise((resolve) => {
        child.once("error", () => resolve(1));
        child.once("exit", (code) => resolve(code ?? 1));
    });
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
}
