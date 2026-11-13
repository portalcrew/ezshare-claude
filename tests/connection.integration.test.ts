import { getByLabelText, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { connect } from "./support/scenario.ts";
import { createTestApp, REPOSITORY, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

test("Given a classic personal access token, When a member connects, Then it is refused with guidance and not stored", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, `ghp_${"c".repeat(36)}`);

    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Create a fine-grained token limited to this repository");
    app.reload();
    await app.eventually(() => getByLabelText(body, "GitHub token"));
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a connected member, When she reloads, Then she stays connected; When her token is later revoked, Then reloading asks for a new one", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.eventually(() => getByText(body, "alice"));
    expect(getByText(body, "This repository is public")).toBeTruthy();

    app.reload();
    await app.eventually(() => getByRole(body, "button", { name: "Disconnect" }));

    app.github.revoke(tokens.alice);
    app.reload();
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("GitHub did not accept this token");
    app.reload();
    await app.eventually(() => getByLabelText(body, "GitHub token"));
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a connected member, When she disconnects, Then her token is forgotten", async () => {
    app = await createTestApp({ isPrivate: true });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Disconnect" })));
    await app.eventually(() => getByLabelText(body, "GitHub token"));

    app.reload();
    await app.eventually(() => getByLabelText(body, "GitHub token"));
    expect(queryByRole(body, "button", { name: "Disconnect" })).toBeNull();
});

test("Given a fork configured with its own execution repository, When a member opens the launcher, Then setup targets that repository and connects without editing it", async () => {
    app = await createTestApp({ defaultRepository: REPOSITORY });
    const body = document.body;
    const field = await app.eventually(() => getByLabelText(body, "Repository"));
    expect(field).toHaveProperty("value", REPOSITORY);
    const template = getByRole(body, "link", { name: /^Create a token \(/u }).getAttribute("href");
    if (template === null) {
        throw new Error("Expected a token template for the fork");
    }
    expect(new URL(template).searchParams.get("target_name")).toBe("team");
    await app.user.type(getByLabelText(body, "GitHub token"), tokens.alice);
    await app.user.click(getByRole(body, "button", { name: "Connect" }));
    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(getByRole(body, "main").textContent).toContain(REPOSITORY);
});
