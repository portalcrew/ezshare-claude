import { getByLabelText, getByRole, queryByRole, within } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { accountSecret, newAccountId } from "../src/shared/accounts.ts";
import { connect } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

test("Given no shared account, When a member connects, Then the empty state explains sharing and no unusable session can start", async () => {
    app = await createTestApp({ sharedToken: null });
    await connect(app, tokens.olivia);
    await app.eventually(() => getByRole(document.body, "status", { name: "Shared accounts" }));
    expect(document.body.textContent).toContain("No accounts shared yet");
    expect(queryByRole(document.body, "button", { name: "Start a session" })).toBeNull();
    expect(app.github.runs).toEqual([]);
});

test("Given an owner with no shared account, When she adds two accounts, refreshes and removes one, Then both were independently shared and the remaining account can start a session", async () => {
    app = await createTestApp({ sharedToken: null });
    const body = document.body;
    await connect(app, tokens.olivia);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    for (const name of ["Design team", "Engineering"]) {
        await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Add account" })));
        await app.user.type(getByLabelText(body, "Account name"), name);
        await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
        await app.user.type(
            await app.eventually(() => getByLabelText(body, "Authorization code")),
            `code-${name.replaceAll(" ", "-")}-1234567890`,
        );
        await app.user.click(getByRole(body, "button", { name: "Submit code" }));
        await app.eventually(() => getByRole(body, "group", { name }));
        await app.eventually(() => expect(app?.github.runs.every((run) => run.status === "completed")).toBe(true));
    }
    app.reload();
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    const design = await app.eventually(() => getByRole(body, "group", { name: "Design team" }));
    expect(getByRole(body, "group", { name: "Engineering" })).toBeTruthy();
    await app.user.click(within(design).getByRole("button", { name: "Remove" }));
    expect(body.textContent).toContain("Running sessions can keep using this credential");
    await app.user.click(getByRole(body, "button", { name: "Cancel" }));
    expect(getByRole(body, "group", { name: "Design team" })).toBeTruthy();
    await app.user.click(within(design).getByRole("button", { name: "Remove" }));
    await app.user.click(getByRole(body, "button", { name: "Remove account" }));
    await app.eventually(() => expect(queryByRole(body, "group", { name: "Design team" })).toBeNull());
    await app.user.click(getByRole(body, "button", { name: "Use a shared account" }));
    const remaining = await app.eventually(() => getByRole(body, "combobox", { name: "Claude account" }));
    await app.user.selectOptions(remaining, within(remaining).getByRole("option", { name: "Engineering" }));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(app.github.runs.at(-1)?.inputs["account"]).not.toBe("legacy");
});

test("Given multiple accounts including the original account, When a member chooses one and switches launcher tabs, Then the selected credential and account label are preserved", async () => {
    app = await createTestApp({ sharedToken: "sk-ant-oat01-REVOKED" });
    const id = newAccountId("Engineering");
    app.github.setSecret(accountSecret(id), "sk-ant-oat01-valid-second-account");
    await connect(app, tokens.alice);
    const body = document.body;
    const picker = await app.eventually(() =>
        getByRole<HTMLSelectElement>(body, "combobox", { name: "Claude account" }),
    );
    expect(picker.value).toBe("");
    expect(getByRole(body, "button", { name: "Start a session" }).getAttribute("aria-disabled")).toBe("true");
    await app.user.selectOptions(picker, id);
    await app.user.click(getByRole(body, "button", { name: "Start a session" }));
    await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(app.github.runs[0]?.inputs["account"]).toBe(id);
    expect(body.textContent).toContain("Account: Engineering");
    await app.user.click(getByRole(body, "button", { name: "Manage shared accounts" }));
    await app.user.click(getByRole(body, "button", { name: "Use a shared account" }));
    await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(body.textContent).toContain("Account: Engineering");
});

test("Given an account was selected, When its owner removes it before the next refresh, Then starting fails without dispatching or silently choosing another account", async () => {
    app = await createTestApp();
    const id = newAccountId("Temporary");
    app.github.setSecret(accountSecret(id), "sk-ant-oat01-temporary-account");
    await connect(app, tokens.alice);
    const body = document.body;
    await app.user.selectOptions(
        await app.eventually(() => getByRole(body, "combobox", { name: "Claude account" })),
        id,
    );
    app.github.setSecret(accountSecret(id), null);
    await app.user.click(getByRole(body, "button", { name: "Start a session" }));
    await app.eventually(() => getByRole(body, "alert"));
    expect(app.github.runs).toEqual([]);
});

test("Given shared accounts exist, When metadata cannot be reached and then recovers, Then a retry warning is distinct from an empty repository", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.eventually(() => getByRole(body, "combobox", { name: "Claude account" }));
    app.github.setSecretsAvailable(false);
    await app.eventually(() => getByRole(body, "button", { name: "Check accounts again" }));
    expect(body.textContent).not.toContain("No accounts shared yet");
    app.github.setSecretsAvailable(true);
    await app.user.click(getByRole(body, "button", { name: "Check accounts again" }));
    await app.eventually(() => getByRole(body, "combobox", { name: "Claude account" }));
});

test("Given two named accounts, When one is reauthorized, Then only that credential is replaced", async () => {
    app = await createTestApp({ sharedToken: null });
    const first = newAccountId("Team A");
    const second = newAccountId("Team B");
    app.github.setSecret(accountSecret(first), "sk-ant-oat01-first-old");
    app.github.setSecret(accountSecret(second), "sk-ant-oat01-second-unchanged");
    await connect(app, tokens.olivia);
    const body = document.body;
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    const row = await app.eventually(() => getByRole(body, "group", { name: "Team A" }));
    await app.user.click(within(row).getByRole("button", { name: "Reauthorize" }));
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByLabelText(body, "Authorization code"));
    await app.user.type(
        await app.eventually(() => getByLabelText(body, "Authorization code")),
        "reauthorize-code-1234567890",
    );
    await app.user.click(getByRole(body, "button", { name: "Submit code" }));
    await app.eventually(() => getByRole(body, "button", { name: "Add account" }));
    expect(app.github.secret(accountSecret(first))).toContain("reauthorize-code");
    expect(app.github.secret(accountSecret(second))).toBe("sk-ant-oat01-second-unchanged");
    expect(app.github.secretNames()).toHaveLength(2);
});

test("Given an owner with only Secrets read permission, When removing an account is denied, Then the account stays listed with a Secrets write error", async () => {
    app = await createTestApp();
    app.github.grant(tokens.olivia, {
        user: { id: 103, login: "olivia", type: "User" },
        actions: true,
        secrets: true,
        secretWrite: false,
    });
    const body = document.body;
    await connect(app, tokens.olivia);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Remove" })));
    await app.user.click(getByRole(body, "button", { name: "Remove account" }));
    await app.eventually(() => expect(getByRole(body, "alert").textContent).toContain("Secrets: Read and write"));
    expect(getByRole(body, "group", { name: "Previously shared account" })).toBeTruthy();
    expect(app.github.secretNames()).toHaveLength(1);
});

test("Given an account name is already in use, When an owner tries to add the same name, Then the existing credential is kept and reauthorization is offered", async () => {
    app = await createTestApp({ sharedToken: null });
    const id = newAccountId("Design team");
    app.github.setSecret(accountSecret(id), "sk-ant-oat01-keep-this-credential");
    const body = document.body;
    await connect(app, tokens.olivia);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Add account" })));
    await app.user.type(getByLabelText(body, "Account name"), "Design team");
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() =>
        expect(getByRole(body, "alert").textContent).toContain("reauthorize the existing account"),
    );
    expect(app.github.secret(accountSecret(id))).toBe("sk-ant-oat01-keep-this-credential");
    expect(app.github.runs).toEqual([]);
});

test("Given repository secrets span more than one page, When the launcher lists accounts, Then all valid account labels appear and unrelated secrets do not", async () => {
    app = await createTestApp();
    for (let index = 0; index < 105; index++) {
        app.github.setSecret(`BUILD_SECRET_${index}`, "unrelated-value");
    }
    app.github.setSecret("EZSHARE_CLAUDE_ACCOUNT_INVALID", "not-an-account");
    const id = newAccountId("\u8bbe\u8ba1\u56e2\u961f");
    app.github.setSecret(accountSecret(id), "sk-ant-oat01-unicode-account");
    const body = document.body;
    await connect(app, tokens.alice);
    const picker = await app.eventually(() => getByRole(body, "combobox", { name: "Claude account" }));
    expect(within(picker).getByRole("option", { name: "\u8bbe\u8ba1\u56e2\u961f" })).toBeTruthy();
    expect(within(picker).getByRole("option", { name: "Previously shared account" })).toBeTruthy();
    expect(within(picker).queryByRole("option", { name: /BUILD_SECRET/u })).toBeNull();
    expect(within(picker).getAllByRole("option")).toHaveLength(3);
});
