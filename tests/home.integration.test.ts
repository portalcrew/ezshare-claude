import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { connect, openPage } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

test("Given one shared account, When a member opens her home, Then she wakes Claude without choosing anything and sees it awake", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    const wake = await app.eventually(() => getByRole(body, "button", { name: "Wake Claude" }));
    const home = getByRole(body, "region", { name: "My Claude" });
    expect(getByText(home, "Asleep")).toBeTruthy();
    expect(queryByRole(body, "combobox", { name: "Claude account" })).toBeNull();
    expect(queryByRole(body, "checkbox", { name: "Use a new Morty identity" })).toBeNull();

    await app.user.click(wake);
    await app.eventually(() => getByText(home, "Waking"));
    expect(home.textContent).toContain("Keep this tab open while Claude is awake");
    await app.eventually(() => getByRole(body, "link", { name: /Open Claude/u }));
    expect(getByText(home, "Awake")).toBeTruthy();
    expect(getByRole(body, "button", { name: "Put to sleep" })).toBeTruthy();
});

test("Given a member on her home, When she opens the account menu, Then team accounts and settings are separate pages she can return from", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await openPage(app, "Team accounts");
    await app.eventually(() => getByRole(body, "region", { name: "Team accounts" }));
    expect(queryByRole(body, "button", { name: "Wake Claude" })).toBeNull();

    await openPage(app, "Settings & troubleshooting");
    const settings = await app.eventually(() => getByRole(body, "region", { name: "Settings & troubleshooting" }));
    expect(getByRole(settings, "checkbox", { name: "Use a new Morty identity" })).toBeTruthy();

    await app.user.click(getByRole(body, "button", { name: "My Claude" }));
    await app.eventually(() => getByRole(body, "button", { name: "Wake Claude" }));
});

test("Given Morty could not connect, When the member retries from her home, Then Claude wakes with a new Morty identity", async () => {
    app = await createTestApp({ mortyFailure: "relay-unavailable" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Wake Claude" })));
    await app.eventually(() => getByRole(body, "alert"));
    await app.user.click(
        await app.eventually(() => getByRole(body, "button", { name: "Try again with a new Morty identity" })),
    );
    await app.eventually(() => expect(app?.github.runs).toHaveLength(2));
    expect(app.github.runs[0]?.inputs["reset_morty_identity"]).toBeUndefined();
    expect(app.github.runs[1]?.inputs["reset_morty_identity"]).toBe("true");
});
