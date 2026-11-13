import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Forbids `.subscribe(...)` in src/web/view-models.
 *
 * Store transitions are explicit actions; reacting to another store by subscribing to it hides a business
 * lifecycle outside those transitions. React subscribes through `useStore` in views and components.
 */
const SCANNED = "src/web/view-models";
const SUBSCRIBE_CALL = /\.subscribe\s*\(/u;

const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", SCANNED], {
    encoding: "utf8",
});
if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(1);
}

const violations: string[] = [];
for (const path of git.stdout.split("\n").filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))) {
    readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
            if (SUBSCRIBE_CALL.test(line)) {
                violations.push(`${path}:${index + 1}: view-models may not subscribe to stores`);
            }
        });
}

if (violations.length > 0) {
    for (const violation of violations) {
        console.error(violation);
    }
    process.exit(1);
}
console.log("View-models do not subscribe to stores.");
