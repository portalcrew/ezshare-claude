import * as v from "valibot";
import { createStore } from "zustand/vanilla";
import { accountSecret, newAccountId, type SharedAccount } from "../../shared/accounts.ts";
import { AppError, type ErrorCode } from "../../shared/errors.ts";
import {
    authorizationCodeSchema,
    authorizationUrl,
    type LoginAccess,
    type LoginBrowserMessage,
    type LoginRunnerMessage,
    loginAccessSchema,
    loginBrowserMessageSchema,
    loginRunnerMessageSchema,
    vscodeDesktopUrl,
    vscodeUrl,
} from "../../shared/protocol.ts";
import { sealForGitHub } from "../services/secret-box.ts";
import { type AccountCatalog, readAccounts } from "./account-catalog.ts";
import {
    beginSession,
    closeMailbox,
    type MemberContext,
    observeSession,
    type SessionRequest,
    sessionExpired,
} from "./session-protocol.ts";
import { StoreWorkflow } from "./store-workflow.ts";

const POLL_MS = 3_000;

const schemas = { outbound: loginBrowserMessageSchema, inbound: loginRunnerMessageSchema };

export type SharingOutcome =
    | { readonly kind: "shared" }
    | { readonly kind: "cancelled" }
    | { readonly kind: "failed"; readonly code: ErrorCode };

type AuthorizationEntry =
    | { readonly kind: "browser"; readonly url: string }
    | { readonly kind: "vscode"; readonly url: string; readonly desktopUrl: string };

export type SharingPhase =
    | { readonly kind: "loading" }
    | { readonly kind: "intro"; readonly outcome: SharingOutcome | null }
    | { readonly kind: "starting" }
    | { readonly kind: "waiting"; readonly session: SessionRequest }
    | { readonly kind: "connecting_vscode"; readonly session: SessionRequest; readonly code: string }
    | { readonly kind: "authorizing"; readonly session: SessionRequest; readonly entry: AuthorizationEntry }
    | { readonly kind: "completing"; readonly session: SessionRequest }
    | { readonly kind: "publishing"; readonly session: SessionRequest };

export type AccountEditor =
    | { readonly kind: "closed" }
    | { readonly kind: "add"; readonly name: string }
    | { readonly kind: "replace"; readonly account: SharedAccount }
    | { readonly kind: "remove"; readonly account: SharedAccount };

export type SharingCommand = "start" | "submit_code" | "cancel" | "remove" | null;

export interface SharingState {
    readonly accounts: AccountCatalog;
    readonly editor: AccountEditor;
    readonly phase: SharingPhase;
    readonly command: SharingCommand;
    readonly problem: ErrorCode | null;
    readonly commandError: ErrorCode | null;
    readonly method: LoginAccess;
}

export interface SharingActions {
    readonly refresh: () => void;
    readonly addAccount: () => void;
    readonly setAccountName: (name: string) => void;
    readonly editAccount: (id: string, operation: "replace" | "remove") => void;
    readonly closeEditor: () => void;
    readonly removeAccount: () => void;
    readonly open: () => void;
    readonly close: () => void;
    /** Starts authorization; the owner has acknowledged what sharing gives every member. */
    readonly start: () => void;
    readonly selectMethod: (method: string) => void;
    readonly submitCode: (code: string) => void;
    readonly cancel: () => void;
}

export type SharingStore = ReturnType<typeof createSharingStore>;

/**
 * The account owner's sharing workflow: authorize Claude in a login run, receive the token over the encrypted
 * channel and immediately store it as the repository secret. The token is never kept in browser storage.
 */
export function createSharingStore(member: MemberContext) {
    // GitHub keeps a finished authorization run visible while its cleanup completes. Its successor queues behind it.
    let ending: string | null = null;
    return createStore<SharingState & SharingActions>()((set, get) => {
        const publish = async (session: SessionRequest, token: string, signal: AbortSignal): Promise<void> => {
            const key = await member.github.secretPublicKey(member.repository.name, signal);
            const sealed = await sealForGitHub(key.key, token, signal);
            await member.github.putSecret(
                member.repository.name,
                accountSecret(session.account),
                key.keyId,
                sealed,
                signal,
            );
            await closeMailbox(member, session);
        };

        const observe = async (session: SessionRequest, signal: AbortSignal): Promise<SharingPhase> => {
            if (sessionExpired(member, session)) {
                await closeMailbox(member, session);
                return { kind: "intro", outcome: { kind: "failed", code: "expired" } };
            }
            const observation = await observeSession(member, session, schemas, signal);
            if (observation.kind === "not_started" || observation.kind === "queued") {
                if (observation.kind === "not_started" && observation.overdue) {
                    await closeMailbox(member, session);
                    return { kind: "intro", outcome: { kind: "failed", code: "github_unavailable" } };
                }
                return { kind: "waiting", session };
            }
            const messages: readonly LoginRunnerMessage[] =
                observation.channel === null ? [] : await observation.channel.receive(signal);
            const token = messages.find((message) => message.kind === "token");
            if (token !== undefined) {
                ending = observation.kind === "running" ? observation.run.id : null;
                set({ phase: { kind: "publishing", session } });
                await publish(session, token.body.token, signal);
                return { kind: "intro", outcome: { kind: "shared" } };
            }
            const failure = messages.find((message) => message.kind === "failed");
            if (failure !== undefined || observation.kind === "finished") {
                await closeMailbox(member, session);
                return {
                    kind: "intro",
                    outcome: { kind: "failed", code: failure === undefined ? "provider_failed" : failure.body.code },
                };
            }
            const current = get().phase;
            if (current.kind === "completing") {
                return current;
            }
            const desktop = messages.find((message) => message.kind === "vscode_login_ready");
            if (desktop !== undefined) {
                return {
                    kind: "authorizing",
                    session,
                    entry: {
                        kind: "vscode",
                        url: authorizationUrl(desktop.body.authorizationUrl),
                        desktopUrl: vscodeDesktopUrl(vscodeUrl(desktop.body.url), "login"),
                    },
                };
            }
            const challenge = messages.find((message) => message.kind === "challenge");
            if (challenge !== undefined) {
                return {
                    kind: "authorizing",
                    session,
                    entry: { kind: "browser", url: authorizationUrl(challenge.body.url) },
                };
            }
            const connection = messages.findLast((message) => message.kind === "vscode_challenge");
            return connection === undefined
                ? { kind: "waiting", session }
                : { kind: "connecting_vscode", session, code: connection.body.code };
        };

        const synchronize = async (signal: AbortSignal): Promise<void> => {
            const phase = get().phase;
            let next: SharingPhase;
            switch (phase.kind) {
                case "loading":
                    next = { kind: "intro", outcome: null };
                    break;
                case "intro":
                    set({ accounts: await readAccounts(member, signal) });
                    return;
                case "starting":
                    return;
                case "waiting":
                case "connecting_vscode":
                case "authorizing":
                case "completing":
                case "publishing":
                    next = await observe(phase.session, signal);
                    break;
                default:
                    return phase satisfies never;
            }
            const accounts = next.kind === "intro" ? await readAccounts(member, signal) : get().accounts;
            set({ phase: next, accounts, problem: null });
        };

        const workflow = new StoreWorkflow<Exclude<SharingCommand, null>>({
            clock: member.clock,
            synchronize,
            interval: () => (get().phase.kind === "intro" ? 30_000 : POLL_MS),
            currentCommand: () => get().command,
            reportProblem: (problem) => set({ problem }),
            commandStarted: (command) => set({ command, commandError: null }),
            commandFinished: (error) =>
                set(error === null ? { command: null } : { command: null, commandError: error }),
        });
        const command = workflow.command;

        return {
            accounts: { kind: "loading" },
            editor: { kind: "closed" },
            refresh: workflow.refresh,
            addAccount: () => {
                if (get().phase.kind === "intro" && get().command === null) {
                    set({ editor: { kind: "add", name: "" } });
                }
            },
            setAccountName: (name) => {
                if (get().editor.kind === "add" && get().command === null) {
                    set({ editor: { kind: "add", name } });
                }
            },
            editAccount: (id, operation) => {
                const state = get();
                if (state.phase.kind !== "intro" || state.command !== null || state.accounts.kind !== "ready") {
                    return;
                }
                const account = state.accounts.items.find((item) => item.id === id);
                if (account !== undefined) {
                    set({ editor: { kind: operation, account } });
                }
            },
            closeEditor: () => {
                if (get().command === null) {
                    set({ editor: { kind: "closed" } });
                }
            },
            removeAccount: () =>
                command("remove", async (signal) => {
                    const editor = get().editor;
                    if (get().phase.kind !== "intro" || editor.kind !== "remove") {
                        return;
                    }
                    await member.github.removeSharedAccount(member.repository.name, editor.account.id, signal);
                    set({ editor: { kind: "closed" }, accounts: await readAccounts(member, signal) });
                }),
            phase: { kind: "loading" },
            command: null,
            problem: null,
            commandError: null,
            method: "browser",
            selectMethod: (method) => {
                if (get().phase.kind === "intro" && get().command === null && v.is(loginAccessSchema, method)) {
                    set({ method });
                }
            },
            open: workflow.open,
            close: workflow.close,
            start: () =>
                command("start", async (signal) => {
                    const phase = get().phase;
                    if (phase.kind !== "intro") {
                        return;
                    }
                    const editor = get().editor;
                    if (editor.kind !== "add" && editor.kind !== "replace") {
                        return;
                    }
                    const account = editor.kind === "replace" ? editor.account.id : newAccountId(editor.name);
                    const accounts = await member.github.sharedAccounts(member.repository.name, signal);
                    if (
                        editor.kind === "add" &&
                        accounts.some(
                            (item) =>
                                item.name?.toLocaleLowerCase() ===
                                editor.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(),
                        )
                    ) {
                        throw new AppError("account_name_taken");
                    }
                    if (editor.kind === "replace" && !accounts.some((item) => item.id === account)) {
                        throw new AppError("shared_account_missing");
                    }
                    // Verify read access before starting the authorization runner.
                    await member.github.secretPublicKey(member.repository.name, signal);
                    if (
                        (await member.github.activeSessions(member.repository.name, member.user, signal)).some(
                            (run) => run.id !== ending,
                        )
                    ) {
                        throw new AppError("session_busy");
                    }
                    set({ phase: { kind: "starting" }, editor: { kind: "closed" } });
                    try {
                        set({
                            phase: {
                                kind: "waiting",
                                session: await beginSession(member, "login", signal, {
                                    loginAccess: get().method,
                                    account,
                                }),
                            },
                        });
                    } catch (cause) {
                        set({ phase, editor });
                        throw cause;
                    }
                }),
            submitCode: (code) =>
                command("submit_code", async (signal) => {
                    const phase = get().phase;
                    const trimmed = code.trim();
                    if (phase.kind !== "authorizing") {
                        return;
                    }
                    if (!v.is(authorizationCodeSchema, trimmed)) {
                        throw new AppError("invalid_input");
                    }
                    const observation = await observeSession(member, phase.session, schemas, signal);
                    if (observation.kind !== "running" || observation.channel === null) {
                        throw new AppError("expired");
                    }
                    const message: LoginBrowserMessage = { kind: "code", body: { code: trimmed } };
                    await observation.channel.send(message, signal);
                    set({ phase: { kind: "completing", session: phase.session } });
                }),
            cancel: () =>
                command("cancel", async (signal) => {
                    const phase = get().phase;
                    if (
                        phase.kind !== "waiting" &&
                        phase.kind !== "connecting_vscode" &&
                        phase.kind !== "authorizing" &&
                        phase.kind !== "completing"
                    ) {
                        return;
                    }
                    const observation = await observeSession(member, phase.session, schemas, signal);
                    if (observation.kind === "queued" || observation.kind === "running") {
                        await member.github.cancelRun(member.repository.name, observation.run.id, signal);
                    }
                    await closeMailbox(member, phase.session);
                    set({ phase: { kind: "intro", outcome: { kind: "cancelled" } } });
                }),
        };
    });
}
