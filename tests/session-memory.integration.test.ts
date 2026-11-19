import { getByLabelText, getByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { connect, openPage } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

/** Inspect the browser's persisted boundary, without reading stored credentials or keys. */
async function storedSlots(): Promise<readonly string[]> {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open("ezshare-claude");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const database = opening.result;
            const transaction = database.transaction("vault", "readonly");
            const keys = transaction.objectStore("vault").getAllKeys();
            transaction.oncomplete = () => {
                database.close();
                resolve(keys.result.filter((key): key is string => typeof key === "string"));
            };
            transaction.onerror = () => {
                database.close();
                reject(transaction.error);
            };
        };
    });
}

test("Given an owner authorizing a named account, When the task is queued, Then its account selection and channel key remain in page memory while login and history storage remain available", async () => {
    app = await createTestApp({ sharedToken: null });
    app.actions.holdQueue();
    const body = document.body;
    await connect(app, tokens.olivia);
    await openPage(app, "Team accounts");
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Add account" })));
    await app.user.type(getByLabelText(body, "Account name"), "Memory only");
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));
    const slots = await storedSlots();
    expect(slots.some((slot) => slot.startsWith("pending:") || slot.startsWith("account:"))).toBe(false);
    expect(slots.some((slot) => slot.startsWith("connection:"))).toBe(true);
    expect(slots.some((slot) => slot.startsWith("history:"))).toBe(true);
    await app.user.click(getByRole(body, "button", { name: "Cancel" }));
    await app.eventually(() => getByRole(body, "button", { name: "Add account" }));
});

test("Given a member with a running chat, When the task is ready, Then browser storage has no temporary session record and the same page can save and end it", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Wake Claude" })));
    await app.eventually(() => getByRole(body, "link", { name: /Open Claude/u }));
    expect((await storedSlots()).some((slot) => slot.startsWith("pending:") || slot.startsWith("account:"))).toBe(
        false,
    );
    await app.user.click(getByRole(body, "button", { name: "Put to sleep" }));
    await app.eventually(() => getByRole(body, "button", { name: "Wake Claude" }));
    expect(getByRole(body, "status").textContent).toContain("files are saved");
});
