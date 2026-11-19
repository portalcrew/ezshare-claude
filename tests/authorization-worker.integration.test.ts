// @vitest-environment node

import { expect, test } from "vitest";
import worker from "../src/authorization/worker.ts";

const workerURL = "https://authorization.example";
const launcher = "https://launcher.example";
const env = { LAUNCHER_URL: `${launcher}/`, REPOSITORY: "team/project", REPOSITORY_ID: "1" };

test("Given an unconfigured authorization Worker, When the launcher checks or exchanges a code, Then it reports unavailable without caching", async () => {
    const health = await worker.fetch(new Request(`${workerURL}/health`), env);
    expect(await health.json()).toEqual({ configured: false });

    const response = await worker.fetch(
        new Request(`${workerURL}/exchange`, { method: "POST", headers: { Origin: launcher } }),
        env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(launcher);
});

test("Given a Worker restricted to one launcher, When a different site asks to exchange a code, Then it has no cross-origin access", async () => {
    const response = await worker.fetch(
        new Request(`${workerURL}/exchange`, { method: "OPTIONS", headers: { Origin: "https://fork.example" } }),
        env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("Given a configured authorization Worker, When the launcher submits invalid exchange data, Then it refuses the request", async () => {
    const configured = { ...env, GITHUB_APP_CLIENT_ID: "Iv1_test", GITHUB_APP_CLIENT_SECRET: "test-secret" };
    const response = await worker.fetch(
        new Request(`${workerURL}/exchange`, {
            method: "POST",
            headers: { Origin: launcher, "Content-Type": "application/json" },
            body: JSON.stringify({ code: "test-code" }),
        }),
        configured,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
});
