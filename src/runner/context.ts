import { readFile, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import * as v from "valibot";
import { AppError } from "../shared/errors.ts";
import { repositoryName } from "../shared/github/client.ts";
import { apiOrigin } from "../shared/github/http.ts";
import {
    type DispatchInputs,
    dispatchInputsSchema,
    type Purpose,
    parseJson,
    runIdSchema,
    userIdSchema,
    workflowPath,
} from "../shared/protocol.ts";

/** The process environment of a workflow step, passed explicitly so nothing reads globals implicitly. */
export type StepEnvironment = Readonly<Record<string, string | undefined>>;

/** The unprivileged OS account that runs Claude and Morty, away from the step's credentials. */
export interface AgentAccount {
    readonly user: string;
    readonly home: string;
}

export interface ActionsContext {
    readonly purpose: Purpose;
    readonly repository: string;
    readonly runId: string;
    readonly userId: string;
    readonly ref: string;
    readonly inputs: DispatchInputs;
    readonly apiOrigin: string;
    readonly token: string;
    readonly runnerTemp: string;
    readonly agent: AgentAccount;
}

const MAX_EVENT_BYTES = 1_000_000;

/**
 * Decodes the Actions context of a session step. This only parses local values; the caller must still verify the
 * run, the request and the mailbox against GitHub before acting on them.
 */
export async function readActionsContext(
    environment: StepEnvironment,
    purpose: Purpose,
    signal: AbortSignal,
): Promise<ActionsContext> {
    const required = (name: string): string => {
        const value = environment[name];
        if (value === undefined || value.length === 0) {
            throw new AppError("unsafe_execution");
        }
        return value;
    };
    if (required("GITHUB_EVENT_NAME") !== "workflow_dispatch" || required("GITHUB_RUN_ATTEMPT") !== "1") {
        throw new AppError("unsafe_execution");
    }
    const repository = repositoryName(required("GITHUB_REPOSITORY"));
    const ref = required("GITHUB_REF");
    if (
        !ref.startsWith("refs/heads/") ||
        required("GITHUB_WORKFLOW_REF").toLowerCase() !== `${repository}/${workflowPath(purpose)}@${ref}`.toLowerCase()
    ) {
        throw new AppError("unsafe_execution");
    }
    const runId = v.safeParse(runIdSchema, required("GITHUB_RUN_ID"));
    const userId = v.safeParse(userIdSchema, required("GITHUB_ACTOR_ID"));
    if (!runId.success || !userId.success) {
        throw new AppError("unsafe_execution");
    }
    const eventPath = absolute(required("GITHUB_EVENT_PATH"));
    if ((await stat(eventPath)).size > MAX_EVENT_BYTES) {
        throw new AppError("invalid_input");
    }
    const event = v.safeParse(
        v.object({ inputs: dispatchInputsSchema }),
        parseJson(await readFile(eventPath, { encoding: "utf8", signal })),
    );
    if (!event.success) {
        throw new AppError("invalid_input");
    }
    const user = required("EZSHARE_AGENT_USER");
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user)) {
        throw new AppError("unsafe_execution");
    }
    return {
        purpose,
        repository,
        runId: runId.output,
        userId: userId.output,
        ref,
        inputs: event.output.inputs,
        apiOrigin: apiOrigin(required("GITHUB_API_URL")),
        token: required("GH_TOKEN"),
        runnerTemp: absolute(required("RUNNER_TEMP")),
        agent: { user, home: absolute(required("EZSHARE_AGENT_HOME")) },
    };
}

function absolute(path: string): string {
    if (!isAbsolute(path) || normalize(path) !== path) {
        throw new AppError("unsafe_execution");
    }
    return path;
}
