import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { connect, openPage } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

test("Given a preferred desktop client, When a member starts and switches to the browser, Then one primary entry follows her choice without another runner and saving is explicit", async () => {
    app = await createTestApp({ isPrivate: false });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.selectOptions(
        await app.eventually(() => getByRole(body, "combobox", { name: "Open with" })),
        "vscode-desktop",
    );
    await app.eventually(() =>
        expect(getByRole<HTMLSelectElement>(body, "combobox", { name: "Open with" }).disabled).toBe(false),
    );
    app.reload();
    await app.eventually(() => {
        expect(getByRole<HTMLSelectElement>(body, "combobox", { name: "Open with" }).value).toBe("vscode-desktop");
    });
    await app.user.click(getByRole(body, "button", { name: "Wake Claude" }));
    await app.eventually(() => getByText(body, "ABCD-EFGH"));
    const run = app.github.runs[0];
    if (run === undefined) {
        throw new Error("Expected a personal session");
    }
    expect(run.inputs["access"]).toBe("vscode");
    await app.actions.authorizeVscode(run.id);
    await app.eventually(() => getByRole(body, "link", { name: /Open in desktop VS Code/u }));
    expect(queryByRole(body, "link", { name: /Open VS Code in browser/u })).toBeNull();
    const timer = getByRole(body, "timer", { name: "Time left" });
    const before = timer.textContent;
    app.clock.advance(60_000);
    await app.eventually(() => expect(timer.textContent).not.toBe(before), 0);
    await app.user.click(getByText(body, "Change access method"));
    await app.user.selectOptions(getByRole(body, "combobox", { name: "Open with" }), "vscode");
    await app.eventually(() => getByRole(body, "link", { name: /Open VS Code in browser/u }));
    expect(queryByRole(body, "link", { name: /Open in desktop VS Code/u })).toBeNull();
    expect(app.github.runs).toHaveLength(1);
    await openPage(app, "Team accounts");
    await app.user.click(getByRole(body, "button", { name: "My Claude" }));
    await app.eventually(() => getByRole(body, "link", { name: /Open VS Code in browser/u }));
    expect(queryByRole(body, "link", { name: /Open in desktop VS Code/u })).toBeNull();
    await app.user.click(getByRole(body, "button", { name: "Put to sleep" }));
    await app.eventually(() => getByText(body, "Saving and putting Claude to sleep…"), 0);
    await app.eventually(() =>
        expect(getByRole(body, "status").textContent).toContain(
            "Claude went to sleep. Your conversation and files are saved for next time.",
        ),
    );
});

test("Given Alice saved a desktop preference, When Bob connects in the same browser, Then his client preference is independent and Alice's returns on reconnect", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.selectOptions(
        await app.eventually(() => getByRole(body, "combobox", { name: "Open with" })),
        "vscode-desktop",
    );
    await app.eventually(() =>
        expect(getByRole<HTMLSelectElement>(body, "combobox", { name: "Open with" }).disabled).toBe(false),
    );
    await openPage(app, "Sign out");
    await connect(app, tokens.bob);
    await app.eventually(() =>
        expect(getByRole<HTMLSelectElement>(body, "combobox", { name: "Open with" }).value).toBe("morty"),
    );
    await openPage(app, "Sign out");
    await connect(app, tokens.alice);
    await app.eventually(() =>
        expect(getByRole<HTMLSelectElement>(body, "combobox", { name: "Open with" }).value).toBe("vscode-desktop"),
    );
});
