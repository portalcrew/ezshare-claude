import { getByLabelText, getByRole, queryByRole, within } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { SHARED_SECRET_NAME } from "../src/shared/protocol.ts";
import { connect } from "./support/scenario.ts";
import { createTestApp, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

async function openSharing(current: TestApp, token: string): Promise<void> {
    await connect(current, token);
    await current.user.click(
        await current.eventually(() => getByRole(document.body, "button", { name: "Share your account" })),
    );
}

test("Given the account owner, When she authorizes Claude and pastes the code, Then the token becomes the repository secret and leaves no trace in the browser", async () => {
    app = await createTestApp();
    const body = document.body;
    await openSharing(app, tokens.olivia);
    expect(getByRole(body, "region", { name: "Share your Claude account" }).textContent).toContain(
        "Every member with write access can read the token",
    );
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));

    const authorization = await app.eventually(() =>
        getByRole(body, "link", { name: /Open the Claude authorization page/u }),
    );
    expect(new URL(authorization.getAttribute("href") ?? "").origin).toBe("https://claude.ai");
    await app.user.type(getByLabelText(body, "Authorization code"), "owner-code-1234567890");
    await app.user.click(getByRole(body, "button", { name: "Submit code" }));

    await app.eventually(() => getByRole(body, "button", { name: "I understand, start authorization" }));
    expect(body.textContent).toContain("Shared with the team");
    expect(app.github.secret(SHARED_SECRET_NAME)).toBe(`sk-ant-oat01-${"S".repeat(24)}owner-code-1234567890`);
    expect(app.github.issues[0]?.state).toBe("closed");

    app.reload();
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Share your account" })));
    await app.eventually(() => getByRole(body, "button", { name: "I understand, start authorization" }));
    expect(body.textContent).not.toContain("Shared with the team");
});

test("Given a member whose token cannot write secrets, When she starts sharing, Then she learns which permission is missing and no run starts", async () => {
    app = await createTestApp();
    const body = document.body;
    await openSharing(app, tokens.alice);
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));

    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Secrets: Read");
    const warning = getByRole(body, "region", { name: "GitHub access needs attention" });
    expect(warning.textContent).toContain("Secrets read and write");
    const template = within(warning)
        .getByRole("link", { name: /Create a token to share my Claude account/u })
        .getAttribute("href");
    expect(new URL(template ?? "").searchParams.get("secrets")).toBe("write");
    await app.user.click(getByRole(body, "button", { name: "Use the team account" }));
    expect(getByRole(body, "region", { name: "GitHub access needs attention" })).toBeTruthy();
    expect(app.github.runs).toEqual([]);
    expect(app.github.issues).toEqual([]);
});

test("Given Claude rejects the code, When the owner submits it, Then sharing ends with a retry hint and nothing is stored", async () => {
    app = await createTestApp();
    const body = document.body;
    await openSharing(app, tokens.olivia);
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.user.type(await app.eventually(() => getByLabelText(body, "Authorization code")), "wrong-code-0000");
    await app.user.click(getByRole(body, "button", { name: "Submit code" }));

    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Claude did not complete the authorization");
    expect(app.github.secret(SHARED_SECRET_NAME)).toBeNull();
});

test("Given an unprotected default branch, When the owner opens sharing, Then she is warned before starting; When she cancels a started authorization, Then the run ends", async () => {
    app = await createTestApp({ branchProtected: false });
    const body = document.body;
    app.actions.holdQueue();
    await openSharing(app, tokens.olivia);
    expect(getByRole(body, "region", { name: "Share your Claude account" }).textContent).toContain(
        "The default branch is not protected",
    );
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Cancel" })));

    await app.eventually(() => getByRole(body, "button", { name: "I understand, start authorization" }));
    expect(body.textContent).toContain("Authorization cancelled. Nothing was shared.");
    expect(app.github.runs[0]?.conclusion).toBe("cancelled");
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a token that can read secret keys but cannot save secrets, When the owner completes authorization, Then the error names Secrets write permission and offers repair", async () => {
    app = await createTestApp();
    const body = document.body;
    await openSharing(app, tokens.olivia);
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    const code = await app.eventually(() => getByLabelText(body, "Authorization code"));
    app.github.grant(tokens.olivia, {
        user: { id: 103, login: "olivia", type: "User" },
        secrets: true,
        secretWrite: false,
        actions: true,
    });
    await app.user.type(code, "owner-code-1234567890");
    await app.user.click(getByRole(body, "button", { name: "Submit code" }));
    await app.eventually(() => {
        expect(getByRole(body, "region", { name: "GitHub access needs attention" }).textContent).toContain(
            "Secrets: Read and write",
        );
    });
    expect(getByRole(body, "button", { name: "Replace GitHub token" })).toBeTruthy();
    expect(app.github.secret(SHARED_SECRET_NAME)).toBeNull();
});

test("Given the owner opened the authorization page, When she never pastes the code, Then the login run ends once its 15-minute lifetime passes", async () => {
    const current = await createTestApp();
    app = current;
    const body = document.body;
    await openSharing(current, tokens.olivia);
    await current.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await current.eventually(() => getByRole(body, "link", { name: /Open the Claude authorization page/u }));
    const run = current.github.runs.at(-1);
    if (run === undefined) {
        throw new Error("Expected the login run");
    }
    const opened = current.clock.now();

    await current.eventually(() => expect(run.status).toBe("completed"), 15_000);

    // Ending the terminal takes real time while the test clock keeps moving, so only the lower bound is exact.
    expect(current.clock.now() - opened).toBeGreaterThanOrEqual(15 * 60_000);
    expect(current.actions.jobs.get(run.id)?.error).toBe("timeout");
    await current.eventually(() => getByRole(body, "button", { name: "I understand, start authorization" }));
});
