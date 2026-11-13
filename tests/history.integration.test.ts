import { readFile, writeFile } from "node:fs/promises";
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
    await current.user.click(getByRole(body, "button", { name: "End session" }));
    await current.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    return getByRole(body, "status").textContent ?? "";
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
    expect(getByRole(body, "main").textContent).toContain("Your previous conversation and workspace are restored");
    expect(second.url.searchParams.get("sessionId")).toBe(first.url.searchParams.get("sessionId"));
    // The restored Claude session is attached directly; no new one is created.
    expect((await app.actions.agentLog(second.runId)).map((entry) => entry.command)).toEqual(["setup"]);
    const job = app.actions.jobs.get(second.runId);
    expect(await readFile(join(job?.agentHome ?? "", "workspace", "notes.txt"), "utf8")).toBe(
        "kept between sessions\nkept between sessions\n",
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

test("Given an archive copied under another member's cache key or modified, When that session starts, Then it cannot be opened and is not overwritten", async () => {
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

    // Flip one byte of Alice's encrypted archive: authentication fails, so nothing of it is unpacked.
    await switchBrowser(app);
    const archive = join(saved, "history.bin");
    const bytes = await readFile(archive);
    bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 0xff;
    await writeFile(archive, bytes);

    await runSession(app);
    expect(getByRole(body, "main").textContent).toContain("Your saved history could not be opened");
    expect(await endSession(app)).toContain("Its history was not saved");
    expect(app.actions.cache.size).toBe(2);
});
