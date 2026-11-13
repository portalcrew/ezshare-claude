import { waitFor } from "@testing-library/dom";
import { userEvent } from "@testing-library/user-event";
import { mountLauncher } from "../../src/web/mount.tsx";
import { startFakeActions } from "./fake-actions.ts";
import { type FakeUser, startFakeGitHub, type TokenGrant } from "./fake-github.ts";
import { TestClock } from "./test-clock.ts";

export const REPOSITORY = "team/ezshare";
const SHARED_CLAUDE_TOKEN = `sk-ant-oat01-${"K".repeat(40)}`;

export const alice: FakeUser = { id: 101, login: "alice", type: "User" };
export const bob: FakeUser = { id: 102, login: "bob", type: "User" };
const olivia: FakeUser = { id: 103, login: "olivia", type: "User" };

export const tokens = {
    alice: `github_pat_alice_${"a".repeat(40)}`,
    bob: `github_pat_bob_${"b".repeat(40)}`,
    olivia: `github_pat_olivia_${"o".repeat(40)}`,
} as const;

/**
 * The complete launcher in happy-dom against a stateful GitHub and Actions. Members act through visible
 * controls; time moves only when `eventually` advances the shared clock.
 */
export async function createTestApp(
    options: {
        readonly isPrivate?: boolean;
        readonly defaultRepository?: string;
        readonly branchProtected?: boolean;
        readonly sharedToken?: string | null;
        readonly mortyFailure?: boolean;
    } = {},
) {
    const clock = new TestClock("2026-11-13T08:00:00.000Z");
    const github = await startFakeGitHub({
        repository: REPOSITORY,
        ...(options.isPrivate === undefined ? {} : { isPrivate: options.isPrivate }),
        ...(options.branchProtected === undefined ? {} : { branchProtected: options.branchProtected }),
    });
    const grants: Record<keyof typeof tokens, TokenGrant> = {
        alice: { user: alice, secrets: false, actions: true },
        bob: { user: bob, secrets: false, actions: true },
        olivia: { user: olivia, secrets: true, actions: true },
    };
    for (const [name, token] of Object.entries(tokens)) {
        const grant = grants[name === "alice" ? "alice" : name === "bob" ? "bob" : "olivia"];
        github.grant(token, grant);
    }
    let sharedToken = options.sharedToken === undefined ? SHARED_CLAUDE_TOKEN : options.sharedToken;
    const actions = await startFakeActions(github, {
        repository: REPOSITORY,
        clock,
        sharedToken: () => sharedToken,
        ...(options.mortyFailure === undefined ? {} : { mortyFailure: options.mortyFailure }),
    });

    document.body.innerHTML = '<main id="app"></main>';
    const root = (): HTMLElement => {
        const element = document.querySelector<HTMLElement>("#app");
        if (element === null) {
            throw new Error("Expected the launcher root");
        }
        return element;
    };
    const launcherOptions = {
        apiOrigin: github.origin,
        clock,
        ...(options.defaultRepository === undefined ? {} : { defaultRepository: options.defaultRepository }),
    };
    let unmount = mountLauncher(root(), launcherOptions);

    return {
        clock,
        github,
        actions,
        user: userEvent.setup(),
        setSharedToken: (value: string | null) => {
            sharedToken = value;
        },
        /** Retries the assertion while moving the clock forward, so polls and runner waits progress. */
        eventually: <T>(assertion: () => T, step = 500): Promise<T> =>
            waitFor(
                () => {
                    clock.advance(step);
                    return assertion();
                },
                { timeout: 20_000, interval: 25 },
            ),
        reload: () => {
            unmount();
            document.body.innerHTML = '<main id="app"></main>';
            unmount = mountLauncher(root(), launcherOptions);
        },
        close: async () => {
            unmount();
            await actions.close();
            await github.close();
        },
    };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
