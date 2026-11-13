import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getByRole, queryByRole } from "@testing-library/dom";
import { IDBFactory } from "fake-indexeddb";
import * as v from "valibot";
import { afterEach, expect, test } from "vitest";
import { connect } from "./support/scenario.ts";
import { alice, bob, createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

function computer(url: URL): string {
    const encoded = new URLSearchParams(url.hash.slice(1)).get("e2e");
    const data: unknown = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
    return v.parse(v.object({ computerId: v.string() }), data).computerId;
}

async function runSession(current: TestApp): Promise<{ readonly url: URL; readonly runId: number }> {
    const body = document.body;
    await current.user.click(await current.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const link = await current.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const run = current.github.runs.at(-1);
    if (run === undefined) {
        throw new Error("Expected a dispatched run");
    }
    return { url: new URL(link.getAttribute("href") ?? ""), runId: run.id };
}

async function endSession(current: TestApp): Promise<string> {
    const body = document.body;
    const run = current.github.runs.at(-1);
    if (run === undefined) {
        throw new Error("Expected the session run");
    }
    await current.user.click(getByRole(body, "button", { name: "End session" }));
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
    expect(getByRole(body, "main").textContent).toContain("first saved session");
    expect(await endSession(app)).toContain("Its history is saved for your next session");
    expect([...app.actions.cache.keys()]).toEqual([`ezshare-history-${alice.id}-run-${first.runId}`]);

    const second = await runSession(app);
    expect(computer(second.url)).toBe(computer(first.url));
    expect(getByRole(body, "main").textContent).toContain("Your previous conversation and workspace are restored");
    expect(second.url.searchParams.get("sessionId")).toBe(first.url.searchParams.get("sessionId"));
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
    expect(app.actions.cache.size).toBe(2);
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
    expect(second.url.searchParams.get("sessionId")).not.toBe(first.url.searchParams.get("sessionId"));
    await app.user.click(getByRole(body, "button", { name: "Replace it from the next session" }));
    await app.eventually(() =>
        expect(getByRole(body, "main").textContent).toContain("Your next session will replace it"),
    );
    expect(await endSession(app)).toContain("Its history was not saved");
    expect(app.actions.cache.size).toBe(1);

    const third = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("first saved session");
    expect(await endSession(app)).toContain("Its history is saved");
    expect(app.actions.cache.size).toBe(2);

    const fourth = await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("restored");
    expect(fourth.url.searchParams.get("sessionId")).toBe(third.url.searchParams.get("sessionId"));
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
        const [saved] = [...app.actions.cache.values()];
        if (saved === undefined) {
            throw new Error("Expected a saved archive");
        }

        // Another member's run restoring Alice's archive (as if it were saved under his key) cannot open it.
        app.actions.cache.set(`ezshare-history-${bob.id}-run-1`, saved);
        await switchBrowser(app, tokens.bob);
        await runSession(app);
        expect(getByRole(body, "main").textContent).toContain("Your saved history could not be opened");
        expect(await endSession(app)).toContain("Its history was not saved");
        expect(app.actions.cache.size).toBe(2);

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
        expect(await endSession(app)).toContain("Its history was not saved");
        expect(app.actions.cache.size).toBe(2);
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
    expect(migrated.url.searchParams.get("sessionId")).toBe(first.url.searchParams.get("sessionId"));
    expect(computer(migrated.url)).not.toBe(computer(first.url));
    await endSession(app);
    const continued = await runSession(app);
    expect(computer(continued.url)).toBe(computer(migrated.url));
    expect(continued.url.searchParams.get("sessionId")).toBe(first.url.searchParams.get("sessionId"));
});

test("Given the launcher closes before unlocking history, When the key deadline expires, Then no new Computer is created and reopening explains how to retry", async () => {
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
    app.reload();
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Keep this launcher open");
});
