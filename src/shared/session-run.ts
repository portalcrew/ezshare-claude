import { AppError } from "./errors.ts";
import type { GitHubClient, Repository, WorkflowRun } from "./github/client.ts";
import { type Purpose, runName, workflowPath } from "./protocol.ts";

export interface SessionRunExpectation {
    readonly repository: Repository;
    readonly purpose: Purpose;
    readonly userId: string;
    readonly requestId: string;
}

/**
 * Proves a run is the member's own first attempt of the session workflow on the default branch.
 * Re-runs are refused: another member could re-run someone else's session.
 */
export function verifySessionRun(run: WorkflowRun, expected: SessionRunExpectation): void {
    if (
        run.path !== workflowPath(expected.purpose) ||
        run.event !== "workflow_dispatch" ||
        run.headBranch !== expected.repository.defaultBranch ||
        run.attempt !== 1 ||
        run.actorId !== expected.userId ||
        run.triggeringActorId !== expected.userId ||
        run.displayTitle !== runName(expected.userId, expected.requestId)
    ) {
        throw new AppError("unsafe_execution");
    }
}

/** Finds the run serving a request, if GitHub has started it yet. */
export async function findSessionRun(
    github: GitHubClient,
    expected: SessionRunExpectation,
    candidates: readonly WorkflowRun[],
    signal: AbortSignal,
): Promise<WorkflowRun | null> {
    const matches = candidates.filter((run) => run.displayTitle === runName(expected.userId, expected.requestId));
    const [match, ...others] = matches;
    if (match === undefined) {
        return null;
    }
    if (others.length > 0) {
        throw new AppError("unsafe_execution");
    }
    const run = await github.run(expected.repository.name, match.id, signal);
    verifySessionRun(run, expected);
    return run;
}
