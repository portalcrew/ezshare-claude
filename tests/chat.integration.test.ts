import { getAllByText, getByRole, queryByRole } from "@testing-library/dom";
import { afterEach, expect, test } from "vitest";
import { SessionChannel } from "../src/shared/channel.ts";
import { createChannelKey, deriveChannelKeys } from "../src/shared/channel-crypto.ts";
import { GitHubClient } from "../src/shared/github/client.ts";
import { chatBrowserMessageSchema, chatRunnerMessageSchema } from "../src/shared/protocol.ts";
import { ACTIONS_BOT } from "./support/fake-github.ts";
import { connect } from "./support/scenario.ts";
import { alice, bob, createTestApp, REPOSITORY, type TestApp, tokens } from "./support/test-app.ts";

let app: TestApp | undefined;
afterEach(async () => {
    await app?.close();
    app = undefined;
});

test("Given a connected member, When she starts a session and later ends it, Then she gets a private chat link and the run cleans up", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));

    const link = await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const url = new URL(link.getAttribute("href") ?? "");
    expect(url.origin).toBe("https://morty.build");
    expect(url.searchParams.get("harness")).toBe("claude");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("workspace")).toMatch(/workspace$/u);
    expect(fragment.get("e2e")).toBe("opaque-morty-encryption-access");

    const run = app.github.runs[0];
    if (run === undefined) {
        throw new Error("Expected a dispatched run");
    }
    expect(run.actor.id).toBe(alice.id);
    const agentLog = await app.actions.agentLog(run.id);
    expect(agentLog.map((entry) => entry.program)).toEqual(["claude", "npx"]);
    for (const entry of agentLog) {
        expect(entry.names.filter((name) => name.startsWith("GH_") || name.startsWith("GITHUB_"))).toEqual([]);
        expect(entry.names).not.toContain("RUNNER_TEMP");
    }

    await app.user.click(getByRole(body, "button", { name: "End session" }));
    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(getByRole(body, "status").textContent).toContain("Your last session ended");
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
    expect(run.conclusion).toBe("success");
    expect((await app.actions.agentLog(run.id)).at(-1)).toMatchObject({ program: "npx", command: "stop" });
    expect(app.github.issues[0]?.state).toBe("closed");
});

test("Given another member can post as the Actions bot, When she forges a ready link and a failure in my mailbox, Then my launcher ignores both and shows my own run's link", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const run = await app.eventually(() => {
        const dispatched = app?.github.runs[0];
        if (dispatched === undefined) {
            throw new Error("Expected a dispatched run");
        }
        return dispatched;
    });
    const issue = app.github.issues[0];
    if (issue === undefined) {
        throw new Error("Expected the mailbox issue");
    }

    // The attacker holds a bot token (from her own run) and her own channel key, but not this run's key.
    app.github.grant("ghs_attacker_run", { user: ACTIONS_BOT, secrets: false, actions: false });
    const attacker = new GitHubClient("ghs_attacker_run", app.github.origin);
    const forger = await createChannelKey();
    const binding = {
        repository: REPOSITORY,
        purpose: "chat" as const,
        issue: issue.number,
        requestId: run.inputs["request_id"] ?? "",
        runId: String(run.id),
        userId: String(alice.id),
    };
    const forged = new SessionChannel({
        github: attacker,
        binding,
        self: "runner",
        keys: await deriveChannelKeys(forger, run.inputs["client_key"] ?? "", binding, "runner"),
        outbound: chatRunnerMessageSchema,
        inbound: chatBrowserMessageSchema,
    });
    const attackerLink = `https://morty.build/continue?harness=claude&sessionId=${crypto.randomUUID()}#code=attacker`;
    await forged.send(
        { kind: "ready", body: { url: attackerLink, accessExpiresAt: "2026-11-13T09:00:00.000Z", history: "new" } },
        AbortSignal.timeout(5000),
    );
    await forged.send({ kind: "failed", body: { code: "agent_failed" } }, AbortSignal.timeout(5000));

    app.actions.release();
    const link = await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(link.getAttribute("href")).not.toBe(attackerLink);
    const ownLink = new URL(link.getAttribute("href") ?? "");
    expect(new URLSearchParams(ownLink.hash.slice(1)).get("workspace")).toMatch(/workspace$/u);
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a ready session, When the member reloads the page, Then the chat link is restored", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const before = (await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }))).getAttribute("href");

    app.reload();

    const after = await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(after.getAttribute("href")).toBe(before);
});

test("Given no account has been shared, When a member starts a session, Then she is told to ask the account owner", async () => {
    app = await createTestApp({ sharedToken: null });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));

    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("No Claude account has been shared with this repository yet");
    expect(getByRole(body, "button", { name: "Start a session" })).toBeTruthy();
});

test("Given another member dispatches a session into my mailbox with her own key, When the run starts, Then it refuses before posting anything", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const issue = await app.eventually(() => {
        const created = app?.github.issues[0];
        if (created === undefined || app?.github.runs.length !== 1) {
            throw new Error("Expected the mailbox and the dispatch");
        }
        return created;
    });
    const requestId = app.github.runs[0]?.inputs["request_id"] ?? "";

    const bobsGitHub = new GitHubClient(tokens.bob, app.github.origin);
    const repository = await bobsGitHub.repository(REPOSITORY, AbortSignal.timeout(5000));
    const bobsKey = await createChannelKey();
    await bobsGitHub.dispatch(
        repository,
        "chat",
        { request_id: requestId, issue: String(issue.number), client_key: bobsKey.publicKey },
        AbortSignal.timeout(5000),
    );
    const hijack = app.github.runs.find((candidate) => candidate.actor.id === bob.id);
    if (hijack === undefined) {
        throw new Error("Expected Bob's run");
    }
    app.actions.start(hijack);
    await app.actions.jobs.get(hijack.id)?.done;

    expect(app.actions.jobs.get(hijack.id)?.error).toBe("unsafe_execution");
    expect(issue.comments).toEqual([]);
    expect(await app.actions.agentLog(hijack.id)).toEqual([]);
});

test("Given a member with an unfinished account-sharing run, When she opens her session page, Then she sees the run and can end it", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.olivia);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Share your account" })));
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));

    await app.user.click(getByRole(body, "button", { name: "Use the team account" }));
    const end = await app.eventually(() => getByRole(body, "button", { name: /^End run/u }));
    expect(getByRole(body, "link", { name: /Account sharing run/u })).toBeTruthy();
    await app.user.click(end);

    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(app.github.runs[0]?.conclusion).toBe("cancelled");
});

test("Given a session still waiting for a runner, When the member cancels it, Then the run never starts", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Cancel" })));
    await app.eventually(() => expect(app?.github.runs[0]?.conclusion).toBe("cancelled"));

    app.actions.release();

    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(app.actions.jobs.size).toBe(0);
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
});

test("Given an account-sharing run shown on the session page, When it finishes before the member clicks End run, Then the page returns to idle without claiming token permissions are missing", async () => {
    app = await createTestApp();
    const body = document.body;
    app.actions.holdQueue();
    await connect(app, tokens.olivia);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Share your account" })));
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));
    await app.user.click(getByRole(body, "button", { name: "Use the team account" }));
    const end = await app.eventually(() => getByRole(body, "button", { name: /^End run/u }));
    const run = app.github.runs[0];
    if (run === undefined) {
        throw new Error("Expected the account-sharing run");
    }
    // GitHub finishes the run after the launcher renders its last confirmed status.
    run.status = "completed";
    run.conclusion = "success";
    await app.user.click(end);
    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(queryByRole(body, "alert")).toBeNull();
    expect(queryByRole(body, "region", { name: "GitHub access needs attention" })).toBeNull();
    expect(run.conclusion).toBe("success");
});

test("Given Morty rejects setup, When a member starts a session, Then she sees one failure and public diagnostics contain only the safe error code", async () => {
    app = await createTestApp({ mortyFailure: true });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Morty could not connect");
    expect(getAllByText(body, "Morty could not connect. Start a new session in a few minutes.")).toHaveLength(1);
    const job = await app.eventually(() => {
        const current = [...(app?.actions.jobs.values() ?? [])][0];
        if (current === undefined) {
            throw new Error("Expected the session job");
        }
        return current;
    });
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "INVALID_REQUEST", exitCode: 1 });
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-provider-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given an older Morty handoff with workspace in the query, When a session starts, Then its validated private link still opens", async () => {
    app = await createTestApp({ mortyHandoff: "legacy" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const link = await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(new URL(link.getAttribute("href") ?? "").searchParams.get("workspace")).toMatch(/workspace$/u);
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a Morty link with conflicting query and fragment workspaces, When setup completes, Then the launcher rejects it without exposing a chat link", async () => {
    app = await createTestApp({ mortyHandoff: "conflicting" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Morty could not connect");
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
});
