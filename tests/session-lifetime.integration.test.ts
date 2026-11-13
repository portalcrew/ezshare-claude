import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import type { Job } from "./support/fake-actions.ts";
import type { FakeRun } from "./support/fake-github.ts";
import { connect } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

const MINUTE = 60_000;

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

async function startSession(current: TestApp): Promise<{ readonly run: FakeRun; readonly job: Job }> {
    const body = document.body;
    await connect(current, tokens.alice);
    await current.user.click(await current.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await current.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const run = current.github.runs.at(-1);
    const job = run === undefined ? undefined : current.actions.jobs.get(run.id);
    if (run === undefined || job === undefined) {
        throw new Error("Expected a running session");
    }
    return { run, job };
}

/** The member sends a message: Claude appends a turn to the session transcript in the agent's home. */
async function chat(agentHome: string): Promise<void> {
    const projects = join(agentHome, ".claude", "projects");
    for (const entry of await readdir(projects, { recursive: true })) {
        if (entry.endsWith(".jsonl")) {
            await appendFile(join(projects, entry), `${JSON.stringify({ type: "user", text: "still here" })}\n`);
        }
    }
}

test("Given a ready session, When nobody uses it for 15 minutes, Then the run ends on its own and saves the history", async () => {
    const current = await createTestApp();
    app = current;
    const body = document.body;
    const { run } = await startSession(current);
    const readyAt = current.clock.now();

    await current.eventually(() => getByRole(body, "button", { name: "Start a session" }), 15_000);

    const idle = current.clock.now() - readyAt;
    expect(idle).toBeGreaterThanOrEqual(14 * MINUTE);
    expect(idle).toBeLessThan(30 * MINUTE);
    expect(getByRole(body, "status").textContent).toContain("Its history is saved");
    await current.eventually(() => expect(run.conclusion).toBe("success"));
    expect(current.actions.cache.size).toBe(1);
});

test("Given a member keeps chatting, When more than an hour passes, Then the session is still running", async () => {
    const current = await createTestApp();
    app = current;
    const body = document.body;
    const { run, job } = await startSession(current);
    const until = current.clock.now() + 75 * MINUTE;

    while (current.clock.now() < until) {
        await chat(job.agentHome);
        const next = Math.min(until, current.clock.now() + 5 * MINUTE);
        await current.eventually(() => expect(current.clock.now()).toBeGreaterThanOrEqual(next), 15_000);
    }

    expect(run.status).toBe("in_progress");
    expect(getByRole(body, "link", { name: /Open chat/u })).toBeDefined();
});
