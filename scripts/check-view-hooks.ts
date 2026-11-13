import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Forbids React hooks in src/web/views, including aliased and namespaced calls the import rule cannot see.
 *
 * Views render view-model state and wire DOM callbacks. They read stores through `useStore` only; any other hook
 * belongs to a component in src/web/components that the view renders.
 */
const SCANNED = "src/web/views";
const ALLOWED_HOOKS = new Set(["useStore"]);
const HOOK_CALL = /(?<![\w$])(?:\w+\.)?(use[A-Z]\w*)\s*(?:<[^()]*>)?\s*\(/gu;
const ALIASED_HOOK = /\buse[A-Z]\w*\s+as\s+(\w+)/gu;

const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", SCANNED], {
    encoding: "utf8",
});
if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(1);
}

const violations: string[] = [];
for (const path of git.stdout.split("\n").filter((line) => line.endsWith(".tsx") || line.endsWith(".ts"))) {
    const source = readFileSync(path, "utf8");
    for (const alias of source.matchAll(ALIASED_HOOK)) {
        violations.push(`${path}: hook imported under the alias ${JSON.stringify(alias[1])}`);
    }
    source.split("\n").forEach((line, index) => {
        for (const match of line.matchAll(HOOK_CALL)) {
            const hook = match[1] ?? "";
            if (!ALLOWED_HOOKS.has(hook)) {
                violations.push(`${path}:${index + 1}: views may not call ${hook}`);
            }
        }
    });
}

if (violations.length > 0) {
    for (const violation of violations) {
        console.error(violation);
    }
    process.exit(1);
}
console.log("Views call no React hooks other than useStore.");
