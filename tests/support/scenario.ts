import { getByLabelText, getByRole } from "@testing-library/dom";
import type { TestApp } from "./test-app.ts";
import { REPOSITORY } from "./test-app.ts";

/** Fills the visible connection steps and connects with the given token. */
export async function connect(app: TestApp, token: string): Promise<void> {
    const body = document.body;
    const repository = await app.eventually(() => getByLabelText(body, "Repository"));
    await app.user.clear(repository);
    await app.user.type(repository, REPOSITORY);
    await app.user.type(getByLabelText(body, "GitHub token"), token);
    await app.user.click(getByRole(body, "button", { name: "Connect" }));
}

/** Opens a page from the account menu, as a member does to reach team accounts or settings. */
export async function openPage(
    app: TestApp,
    page: "My Claude" | "Team accounts" | "Settings & troubleshooting" | "Sign out",
): Promise<void> {
    const body = document.body;
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Account menu" })));
    await app.user.click(getByRole(body, "menuitem", { name: page }));
}
