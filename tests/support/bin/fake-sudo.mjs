// Controlled stand-in for `sudo -n -u <user> --preserve-env=<names> -- <command>`.
// Like sudo's env_reset, only the preserved variables reach the command.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const [nonInteractive, userFlag, user, preserve, separator, ...command] = args;
if (
    nonInteractive !== "-n" ||
    userFlag !== "-u" ||
    !/^[a-z_][a-z0-9_-]*$/u.test(user ?? "") ||
    !preserve?.startsWith("--preserve-env=") ||
    separator !== "--" ||
    command.length === 0
) {
    console.error("fake sudo: unexpected command line");
    process.exit(2);
}
const names = preserve.slice("--preserve-env=".length).split(",");
const env = Object.fromEntries(names.filter((name) => name in process.env).map((name) => [name, process.env[name]]));
const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
});
