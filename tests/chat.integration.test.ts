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
    expect(url.pathname).toBe("/continue");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#h=[\w-]+\.[\w-]{22}$/u);

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
        expect(entry.names).not.toContain("ACTIONS_RUNTIME_TOKEN");
    }

    await app.user.click(getByRole(body, "button", { name: "Save and end session" }));
    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    expect(getByRole(body, "status").textContent).toContain("Your last session ended");
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
    await app.eventually(() => expect(run.conclusion).toBe("success"));
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
    expect(ownLink.hash).toMatch(/^#h=/u);
    expect(queryByRole(body, "alert")).toBeNull();
});

test("Given a ready session, When the member switches launcher tabs, Then the current chat link is preserved", async () => {
    app = await createTestApp();
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const before = (await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }))).getAttribute("href");

    await app.user.click(getByRole(body, "button", { name: "Manage shared accounts" }));
    await app.user.click(getByRole(body, "button", { name: "Use a shared account" }));

    const after = await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    expect(after.getAttribute("href")).toBe(before);
});

test("Given no account has been shared, When a member opens the launcher, Then an empty state directs her to account sharing before a run can start", async () => {
    app = await createTestApp({ sharedToken: null });
    await connect(app, tokens.alice);
    await app.eventually(() => getByRole(document.body, "status", { name: "Shared accounts" }));
    expect(document.body.textContent).toContain("No accounts shared yet");
    expect(queryByRole(document.body, "button", { name: "Start a session" })).toBeNull();
    expect(app.github.runs).toEqual([]);
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
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Reauthorize" })));
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));

    await app.user.click(getByRole(body, "button", { name: "Use a shared account" }));
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
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Manage shared accounts" })));
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Reauthorize" })));
    await app.user.click(getByRole(body, "button", { name: "I understand, start authorization" }));
    await app.eventually(() => getByRole(body, "button", { name: "Cancel" }));
    await app.user.click(getByRole(body, "button", { name: "Use a shared account" }));
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

test("Given Morty reports a setup failure on stderr, When a member starts a session, Then she sees one failure and public diagnostics contain only the safe error code", async () => {
    app = await createTestApp({ mortyFailure: "provider" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Morty could not connect");
    expect(getAllByText(body, /^Morty could not connect\./u)).toHaveLength(1);
    expect(alert.textContent).toContain("choose VS Code");
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

test("Given Morty seals a handoff for a different workspace, When setup completes, Then the launcher rejects it without exposing a chat link", async () => {
    app = await createTestApp({ mortyHandoff: "conflicting" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    const alert = await app.eventually(() => getByRole(body, "alert"));
    expect(alert.textContent).toContain("Morty could not connect");
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
});

test("Given the runner image points XDG_CONFIG_HOME at the runner's home, When Claude and Morty start, Then their tools keep configuration in the agent's own home", async () => {
    const current = await createTestApp();
    app = current;
    const body = document.body;
    await connect(current, tokens.alice);
    await current.user.click(await current.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await current.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const run = current.github.runs[0];
    const job = run === undefined ? undefined : current.actions.jobs.get(run.id);
    if (run === undefined || job === undefined) {
        throw new Error("Expected a running session");
    }

    const agentLog = await current.actions.agentLog(run.id);

    expect(agentLog.length).toBeGreaterThan(0);
    for (const entry of agentLog) {
        expect(entry.configHome).toBe(`${job.agentHome}/.config`);
    }
});

test("Given npm rejects the workspace configuration, When a member starts a session, Then public diagnostics contain its safe structured code without workspace details", async () => {
    app = await createTestApp({ mortyFailure: "npm" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "EJSONPARSE", exitCode: 1 });
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-workspace-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given npm latest temporarily refers to an unavailable version, When a member starts a session, Then setup retries and opens the private chat", async () => {
    app = await createTestApp({ mortyFailure: "npm-transient" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    expect(job.diagnostics).toContainEqual({ event: "morty.retrying", code: "ETARGET", attempt: 1 });
    expect(queryByRole(body, "alert")).toBeNull();
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-workspace-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given npm latest stays unavailable, When setup exhausts its bounded retries, Then the member sees a failure and public diagnostics identify npm", async () => {
    app = await createTestApp({ mortyFailure: "npm-unavailable" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "ETARGET", exitCode: 1 });
    expect(job.diagnostics.filter((record) => record.event === "morty.retrying")).toHaveLength(2);
    expect(queryByRole(body, "link", { name: /Open chat/u })).toBeNull();
});

test.each([
    ["computer-conflict", "COMPUTER_CONFLICT"],
    ["node-module", "ERR_MODULE_NOT_FOUND"],
    ["npm-text", "EACCES"],
    ["unknown", "UNRECOGNIZED"],
] as const)(
    "Given a %s startup error, When a member starts a session, Then diagnostics report %s without private output",
    async (mortyFailure, code) => {
        app = await createTestApp({ mortyFailure });
        await connect(app, tokens.alice);
        await app.user.click(
            await app.eventually(() => getByRole(document.body, "button", { name: "Start a session" })),
        );
        await app.eventually(() => getByRole(document.body, "alert"));
        const job = [...app.actions.jobs.values()][0];
        if (job === undefined) {
            throw new Error("Expected the session job");
        }
        await job.done;
        expect(job.diagnostics).toContainEqual({ event: "morty.failed", code, exitCode: 1 });
        expect(JSON.stringify(job.diagnostics)).not.toContain("private-provider-detail");
        expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
    },
);

test("Given npm returns 404 for Morty during publication, When a member starts a session, Then setup retries and opens the private chat", async () => {
    app = await createTestApp({ mortyFailure: "npm404-transient" });
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(document.body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(document.body, "link", { name: /Open chat/u }));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    expect(job.diagnostics).toContainEqual({ event: "morty.retrying", code: "E404", attempt: 1 });
    expect(queryByRole(document.body, "alert")).toBeNull();
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-workspace-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given npm keeps returning 404 for Morty, When the bounded installation retries are exhausted, Then the member sees a failure with a safe registry code", async () => {
    app = await createTestApp({ mortyFailure: "npm404-unavailable" });
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(document.body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(document.body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected the session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "E404", exitCode: 1 });
    expect(job.diagnostics.filter((record) => record.event === "morty.retrying")).toHaveLength(11);
    expect(queryByRole(document.body, "link", { name: /Open chat/u })).toBeNull();
});

test("Given a revoked Morty runtime connection, When setup fails, Then the public diagnostic includes only allowlisted causes and preserves the failure", async () => {
    app = await createTestApp({ mortyFailure: "runtime-revoked" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected a session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.cause", code: "computer_pairing_revoked", depth: 2 });
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "RUNTIME_START_FAILED", exitCode: 1 });
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-provider-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given a temporarily unavailable Morty service, When setup runs again, Then the session opens after a bounded retry", async () => {
    app = await createTestApp({ mortyFailure: "relay-transient" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "link", { name: /Open chat/u }));
    await app.user.click(getByRole(body, "button", { name: "Save and end session" }));
    await app.eventually(() => getByRole(body, "button", { name: "Start a session" }));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected a session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.retrying", code: "RELAY_UNAVAILABLE", attempt: 1 });
    expect(job.diagnostics).toContainEqual({ event: "morty.cause", code: "ECONNRESET", depth: 2 });
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-provider-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given Morty stays unavailable, When setup exhausts its retries, Then the session fails once with safe diagnostics", async () => {
    app = await createTestApp({ mortyFailure: "relay-unavailable" });
    const body = document.body;
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected a session job");
    }
    await job.done;
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "RELAY_UNAVAILABLE", exitCode: 1 });
    expect(job.diagnostics.filter((record) => record.event === "morty.retrying")).toHaveLength(2);
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-provider-detail");
    expect(JSON.stringify(job.diagnostics)).not.toContain("private-code");
});

test("Given Morty rejects even a replacement Computer, When a member starts, Then identity recovery stops after one attempt and reports the safe failure", async () => {
    app = await createTestApp({ mortyFailure: "computer-revoked" });
    await connect(app, tokens.alice);
    await app.user.click(await app.eventually(() => getByRole(document.body, "button", { name: "Start a session" })));
    await app.eventually(() => getByRole(document.body, "alert"));
    const job = [...app.actions.jobs.values()][0];
    if (job === undefined) {
        throw new Error("Expected a session job");
    }
    await job.done;
    expect(
        job.diagnostics.filter(
            (record) => record.event === "session.stage" && record.stage === "resetting_morty_identity",
        ),
    ).toHaveLength(1);
    expect(job.diagnostics).toContainEqual({ event: "morty.failed", code: "computer_revoked", exitCode: 1 });
    expect(queryByRole(document.body, "link", { name: /Open chat/u })).toBeNull();
});
