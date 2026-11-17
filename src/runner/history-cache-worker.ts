import { isAbsolute } from "node:path";
import { saveCache } from "@actions/cache";
import * as v from "valibot";

// Runs only in the trusted controller's bounded child process. SDK output stays captured there.
const args = v.safeParse(
    v.tuple([
        v.pipe(v.string(), v.regex(/^ezshare-history-[1-9][0-9]*-run-[1-9][0-9]*-checkpoint-[a-f0-9-]{36}$/u)),
        v.pipe(v.string(), v.check(isAbsolute)),
    ]),
    process.argv.slice(2),
);
try {
    if (!args.success) {
        process.exitCode = 1;
    } else {
        const id = await saveCache([args.output[1]], args.output[0]);
        if (!Number.isSafeInteger(id) || id < 1) {
            process.exitCode = 1;
        }
    }
} catch {
    process.exitCode = 1;
}
