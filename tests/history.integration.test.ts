import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getByRole, queryByRole } from "@testing-library/dom";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, test } from "vitest";
import { connect } from "./support/scenario.ts";
import { alice, bob, createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

const finalCacheKeys = (current: TestApp) =>
    [...current.actions.cache.keys()].filter((key) => !key.includes("-checkpoint-"));

async function readySession(current: TestApp, runId: number, link: HTMLElement) {
    const fragment = new URL(link.getAttribute("href") ?? "").hash;
    const computerId = /^#h=(.+)\.[\w-]{22}$/u.exec(fragment)?.[1];
    const sessionId = (await current.actions.agentLog(runId)).find((entry) => entry.program === "npx")?.sessionId;
    if (computerId === undefined || typeof sessionId !== "string") {
        throw new Error("Expected a sealed link and an attached Claude session");
    }
    return { computerId, sessionId, runId };
}

async function runSession(current: TestApp) {
    const body = document.body;
    await current.user.click(await current.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const link = await current.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const run = current.github.runs.at(-1);
    if (run === undefined) {
        throw new Error("Expected a dispatched run");
    }
    return readySession(current, run.id, link);
}

async function endSession(current: TestApp): Promise<string> {
    const body = document.body;
    const run = current.github.runs.at(-1);
    if (run === undefined) {
        throw new Error("Expected the session run");
    }
    const button = getByRole(body, "button", { name: /^(Save and end session|End session)$/u });
    const expected = button.textContent?.includes("Save and end session")
        ? "Saving and ending your session…"
        : "Ending your session…";
    await current.user.click(button);
    const feedback = await current.eventually(() => {
        const text = getByRole(body, "status").textContent;
        expect(text).toMatch(/^(Saving and ending your session…|Ending your session…)$/u);
        return text;
    }, 0);
    expect(feedback).toBe(expected);
    await current.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    const message = getByRole(body, "status").textContent ?? "";
    // The stopped message precedes the workflow's cache-save step.
    await current.eventually(() => expect(run.status).toBe("completed"));
    return message;
}

/** A new browser profile: nothing the previous one stored is available. */
async function switchBrowser(current: TestApp, token: string = tokens.alice): Promise<void> {
    globalThis.indexedDB = new IDBFactory();
    current.reload();
    await connect(current, token);
}

test("Given a member ended a session, When she starts the next one, Then it continues the same conversation and workspace", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);

    const first = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("New workspace.");
    expect(await endSession(app)).toContain("Its history is saved for your next session");
    expect(finalCacheKeys(app)).toEqual([`ezshare-history-${alice.id}-run-${first.runId}`]);

    const second = await runSession(app);
    expect(second.computerId).toBe(first.computerId);
    expect(getByRole(body, "main").textContent).toContain("Your previous conversation and workspace are restored");
    expect(second.sessionId).toBe(first.sessionId);
    // The restored Claude session is attached directly; no new one is created.
    expect((await app.actions.agentLog(second.runId)).map((entry) => entry.command)).toEqual(["setup"]);
    const job = app.actions.jobs.get(second.runId);
    expect(await readFile(join(job?.agentHome ?? "", "workspace", "notes.txt"), "utf8")).toBe(
        "kept between sessions\nkept between sessions\n",
    );
    expect(await readFile(join(job?.agentHome ?? "", "morty", "computer", "sessions", "events.jsonl"), "utf8")).toBe(
        '{"text":"turn via morty"}\n{"text":"turn via morty"}\n',
    );
    expect(await endSession(app)).toContain("Its history is saved");
    expect(finalCacheKeys(app)).toHaveLength(2);
});

test("Given history saved from another browser, When the member starts a session here, Then it starts empty, keeps the old archive, and replaces it only when she asks", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    const first = await runSession(app);
    await endSession(app);

    await switchBrowser(app);
    const second = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("Your saved history could not be opened");
    expect(second.sessionId).not.toBe(first.sessionId);
    await app.user.click(getByRole(body, "button", { name: "Replace it from the next session" }));
    await app.eventually(() =>
        expect(getByRole(body, "main").textContent).toContain("Your next session will replace it"),
    );
    const outcome = await endSession(app);
    expect(outcome).toContain("The final save did not complete");
    expect(getByRole(body, "status").textContent).toBe(outcome);
    expect(getByRole(body, "main").textContent?.match(/The final save did not complete/gu)).toHaveLength(1);
    expect(finalCacheKeys(app)).toHaveLength(1);

    const third = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("New workspace.");
    expect(await endSession(app)).toContain("Its history is saved");
    expect(finalCacheKeys(app)).toHaveLength(2);

    const fourth = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("restored");
    expect(fourth.sessionId).toBe(third.sessionId);
    expect(queryByRole(body, "button", { name: "Replace it from the next session" })).toBeNull();
});

test.each(["modified ciphertext", "truncated tag"])(
    "Given an archive copied under another member's cache key or containing %s, When that session starts, Then it cannot be opened and is not overwritten",
    async (damage) => {
        app = await createTestApp();
        const body = document.body;
        await connect(app, tokens.alice);
        await runSession(app);
        await endSession(app);
        const saved = [...app.actions.cache.values()].at(-1);
        if (saved === undefined) {
            throw new Error("Expected a saved archive");
        }

        // Another member's run restoring Alice's archive (as if it were saved under his key) cannot open it.
        app.actions.cache.set(`ezshare-history-${bob.id}-run-1`, saved);
        await switchBrowser(app, tokens.bob);
        await runSession(app);
        expect(getByRole(body, "main").textContent).toContain("Your saved history could not be opened");
        expect(await endSession(app)).toContain("The final save did not complete");
        expect(finalCacheKeys(app)).toHaveLength(2);

        // Damaged ciphertext or an incomplete tag must fail before anything is unpacked.
        await switchBrowser(app);
        const archive = join(saved, "history.bin");
        const bytes = await readFile(archive);
        if (damage === "modified ciphertext") {
            bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 0xff;
        }
        await writeFile(archive, damage === "truncated tag" ? bytes.subarray(0, bytes.length - 12) : bytes);

        await runSession(app);
        expect(getByRole(body, "main").textContent).toContain("Your saved history could not be opened");
        expect(await endSession(app)).toContain("The final save did not complete");
        expect(finalCacheKeys(app)).toHaveLength(2);
    },
);

test("Given an older archive without Morty identity, When the member continues twice, Then Claude history survives and the new Computer is retained after migration", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const first = await runSession(app);
    const job = app.actions.jobs.get(first.runId);
    if (job === undefined) {
        throw new Error("Expected the first session job");
    }
    // Previous releases excluded this directory from the archived home.
    await rm(join(job.agentHome, "morty"), { recursive: true, force: true });
    await endSession(app);
    const migrated = await runSession(app);
    expect(migrated.sessionId).toBe(first.sessionId);
    expect(migrated.computerId).not.toBe(first.computerId);
    await endSession(app);
    const continued = await runSession(app);
    expect(continued.computerId).toBe(migrated.computerId);
    expect(continued.sessionId).toBe(first.sessionId);
});

test("Given the launcher closes before unlocking history, When the key deadline expires, Then no new Computer or archive is created", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));
    app.suspend();
    app.actions.release();
    const job = await app.eventually(() => {
        const current = [...(app?.actions.jobs.values() ?? [])][0];
        if (
            current === undefined ||
            !current.diagnostics.some(
                (record) => record.event === "session.stage" && record.stage === "awaiting_history",
            )
        ) {
            throw new Error("Expected the runner to wait for its browser key");
        }
        return current;
    });
    app.clock.advance(5 * 60_000);
    await app.eventually(() => expect(job.error).toBe("history_key_missing"));
    expect(app.actions.cache.size).toBe(0);
    expect((await app.actions.agentLog(job.run.id)).some((entry) => entry.command === "setup")).toBe(false);
});

test("Given saved conversation and Morty identity, When the member chooses a new Morty identity and starts, Then only Morty state is replaced and the next session keeps the new identity", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const first = await runSession(app);
    await endSession(app);
    const checkbox = getByRole(document.body, "checkbox", { name: "Use a new Morty identity" });
    expect(getByRole(document.body, "checkbox", { name: "Use a new Morty identity", checked: false })).toBe(checkbox);
    await app.user.click(checkbox);
    app.actions.holdQueue();
    await app.user.click(getByRole(document.body, "button", { name: "Start a session" }));
    const dispatched = await app.eventually(() => {
        const run = app?.github.runs.at(-1);
        if (run === undefined || run.id === first.runId) {
            throw new Error("Expected the new session");
        }
        return run;
    });
    app.actions.release();
    const link = await app.eventually(() => getByRole(document.body, "link", { name: /Open chat/u }));
    const second = await readySession(app, dispatched.id, link);
    expect(second.computerId).not.toBe(first.computerId);
    expect(second.sessionId).toBe(first.sessionId);
    const job = app.actions.jobs.get(second.runId);
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    expect(await readFile(join(job.agentHome, "workspace", "notes.txt"), "utf8")).toBe(
        "kept between sessions\nkept between sessions\n",
    );
    expect(await readFile(join(job.agentHome, "morty", "computer", "sessions", "events.jsonl"), "utf8")).toBe(
        '{"text":"turn via morty"}\n',
    );
    await endSession(app);
    const third = await runSession(app);
    expect(third.computerId).toBe(second.computerId);
    expect(third.sessionId).toBe(first.sessionId);
});

test("Given an archived Morty Computer was revoked, When the member starts again, Then only Morty identity is renewed and Claude history survives this and the next session", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const first = await runSession(app);
    const home = app.actions.jobs.get(first.runId)?.agentHome;
    if (home === undefined) {
        throw new Error("Expected the member's agent home");
    }
    await writeFile(
        join(home, "morty", "config.json"),
        JSON.stringify({ computerId: first.computerId, revoked: true }),
    );
    await endSession(app);
    const second = await runSession(app);
    expect(second.computerId).not.toBe(first.computerId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(document.body.textContent).toContain("Your previous conversation and workspace are restored");
    await endSession(app);
    const third = await runSession(app);
    expect(third.computerId).toBe(second.computerId);
    expect(third.sessionId).toBe(first.sessionId);
});

test("Given a running session, When a runner dies after an automatic encrypted save, Then the next session restores the last uploaded conversation and workspace", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const first = await runSession(app);
    await app.eventually(() => expect(app?.actions.cache.size).toBeGreaterThan(0));
    const home = app.actions.jobs.get(first.runId)?.agentHome;
    if (home === undefined) {
        throw new Error("Expected the running workspace");
    }
    await writeFile(join(home, "workspace", "checkpoint.txt"), "saved while running");
    app.clock.advance(5 * 60_000);
    await app.eventually(() =>
        expect(
            app?.actions.jobs
                .get(first.runId)
                ?.diagnostics.some(
                    (entry) =>
                        entry.event === "history.checkpoint" && entry.outcome === "saved" && entry.sequence === 2,
                ),
        ).toBe(true),
    );
    await app.actions.crashRunner(first.runId);
    await app.eventually(() => getByRole(document.body, "button", { name: "Start a session" }));
    const next = await runSession(app);
    const nextHome = app.actions.jobs.get(next.runId)?.agentHome;
    if (nextHome === undefined) {
        throw new Error("Expected the restored workspace");
    }
    expect(await readFile(join(nextHome, "workspace", "checkpoint.txt"), "utf8")).toBe("saved while running");
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.computerId).toBe(first.computerId);
});

test("Given a saved running session, When uploads fail and later recover, Then the last good snapshot remains and automatic saving retries without ending the chat", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const running = await runSession(app);
    await app.eventually(() => expect(app?.actions.cache.size).toBeGreaterThan(0));
    const before = [...app.actions.cache.keys()];
    app.actions.setHistoryUploadsAvailable(false);
    app.clock.advance(5 * 60_000);
    await app.eventually(() =>
        expect(
            app?.actions.jobs
                .get(running.runId)
                ?.diagnostics.some((entry) => entry.event === "history.checkpoint" && entry.outcome === "failed"),
        ).toBe(true),
    );
    expect([...app.actions.cache.keys()]).toEqual(before);
    expect(getByRole(document.body, "link", { name: /Open chat/u })).toBeTruthy();
    app.actions.setHistoryUploadsAvailable(true);
    app.clock.advance(5 * 60_000);
    await app.eventually(() =>
        expect(
            app?.actions.jobs
                .get(running.runId)
                ?.diagnostics.some(
                    (entry) =>
                        entry.event === "history.checkpoint" && entry.outcome === "saved" && entry.sequence === 3,
                ),
        ).toBe(true),
    );
    expect(queryByRole(document.body, "alert")).toBeNull();
});

test("Given a member keeps chatting, When several automatic saves succeed, Then only the last two running snapshots are retained", async () => {
    app = await createTestApp();
    await connect(app, tokens.alice);
    const running = await runSession(app);
    await app.eventually(() => expect(app?.actions.cache.size).toBeGreaterThan(0));
    const home = app.actions.jobs.get(running.runId)?.agentHome;
    if (home === undefined) {
        throw new Error("Expected a personal workspace");
    }
    const project = join(home, ".claude", "projects", join(home, "workspace").replaceAll(/[^A-Za-z0-9]/gu, "-"));
    for (const sequence of [2, 3, 4]) {
        await appendFile(
            join(project, `${running.sessionId}.jsonl`),
            `${JSON.stringify({ type: "user", message: "still chatting" })}\n`,
        );
        app.clock.advance(5 * 60_000);
        await app.eventually(() =>
            expect(
                app?.actions.jobs
                    .get(running.runId)
                    ?.diagnostics.some(
                        (entry) =>
                            entry.event === "history.checkpoint" &&
                            entry.outcome === "saved" &&
                            entry.sequence === sequence,
                    ),
            ).toBe(true),
        );
    }
    await app.eventually(() => expect(app?.actions.cache.size).toBe(2));
    expect(getByRole(document.body, "link", { name: /Open chat/u })).toBeTruthy();
});
