import * as v from "valibot";
import { createStore } from "zustand/vanilla";
import { AppError, type ErrorCode, toAppError } from "../../shared/errors.ts";
import {
    authorizationCodeSchema,
    authorizationUrl,
    type LoginBrowserMessage,
    type LoginRunnerMessage,
    loginBrowserMessageSchema,
    loginRunnerMessageSchema,
    SHARED_SECRET_NAME,
} from "../../shared/protocol.ts";
import { sealForGitHub } from "../services/secret-box.ts";
import type { PendingSession } from "../services/vault.ts";
import { SerialWork } from "./serial-work.ts";
import {
    abandonSession,
    beginSession,
    type MemberContext,
    observeSession,
    sessionExpired,
} from "./session-protocol.ts";

const POLL_MS = 3_000;

export type SharingOutcome =
    | { readonly kind: "shared" }
    | { readonly kind: "cancelled" }
    | { readonly kind: "failed"; readonly code: ErrorCode };

export type SharingPhase =
    | { readonly kind: "loading" }
    | { readonly kind: "intro"; readonly outcome: SharingOutcome | null }
    | { readonly kind: "starting" }
    | { readonly kind: "waiting"; readonly session: PendingSession }
    | { readonly kind: "authorizing"; readonly session: PendingSession; readonly url: string }
    | { readonly kind: "completing"; readonly session: PendingSession }
    | { readonly kind: "publishing"; readonly session: PendingSession };

export type SharingCommand = "start" | "submit_code" | "cancel" | null;

export interface SharingState {
    readonly phase: SharingPhase;
    readonly command: SharingCommand;
    readonly problem: ErrorCode | null;
    readonly commandError: ErrorCode | null;
}

export interface SharingActions {
    readonly open: () => void;
    readonly close: () => void;
    /** Starts authorization; the owner has acknowledged what sharing gives every member. */
    readonly start: () => void;
    readonly submitCode: (code: string) => void;
    readonly cancel: () => void;
}

export type SharingStore = ReturnType<typeof createSharingStore>;

/**
 * The account owner's sharing workflow: authorize Claude in a login run, receive the token over the encrypted
 * channel and immediately store it as the repository secret. The token is never kept in browser storage.
 */
export function createSharingStore(member: MemberContext) {
    const work = new SerialWork();
    let wake: AbortController | null = null;
    const schemas = { outbound: loginBrowserMessageSchema, inbound: loginRunnerMessageSchema };

    return createStore<SharingState & SharingActions>()((set, get) => {
        const publish = async (session: PendingSession, token: string, signal: AbortSignal): Promise<void> => {
            const key = await member.github.secretPublicKey(member.repository.name, signal);
            const sealed = await sealForGitHub(key.key, token, signal);
            await member.github.putSecret(member.repository.name, SHARED_SECRET_NAME, key.keyId, sealed, signal);
            await abandonSession(member, session);
        };

        const observe = async (session: PendingSession, signal: AbortSignal): Promise<SharingPhase> => {
            if (sessionExpired(member, session)) {
                await abandonSession(member, session);
                return { kind: "intro", outcome: { kind: "failed", code: "expired" } };
            }
            const observation = await observeSession(member, session, schemas, signal);
            if (observation.kind === "not_started" || observation.kind === "queued") {
                if (observation.kind === "not_started" && observation.overdue) {
                    await abandonSession(member, session);
                    return { kind: "intro", outcome: { kind: "failed", code: "github_unavailable" } };
                }
                return { kind: "waiting", session };
            }
            const messages: readonly LoginRunnerMessage[] =
                observation.channel === null ? [] : await observation.channel.receive(signal);
            const token = messages.find((message) => message.kind === "token");
            if (token !== undefined) {
                set({ phase: { kind: "publishing", session } });
                await publish(session, token.body.token, signal);
                return { kind: "intro", outcome: { kind: "shared" } };
            }
            const failure = messages.find((message) => message.kind === "failed");
            if (failure !== undefined || observation.kind === "finished") {
                await abandonSession(member, session);
                return {
                    kind: "intro",
                    outcome: { kind: "failed", code: failure === undefined ? "provider_failed" : failure.body.code },
                };
            }
            const current = get().phase;
            if (current.kind === "completing") {
                return current;
            }
            const challenge = messages.find((message) => message.kind === "challenge");
            return challenge === undefined
                ? { kind: "waiting", session }
                : { kind: "authorizing", session, url: authorizationUrl(challenge.body.url) };
        };

        const synchronize = async (signal: AbortSignal): Promise<void> => {
            const phase = get().phase;
            let next: SharingPhase;
            switch (phase.kind) {
                case "loading": {
                    const saved = await member.vault.loadPending(
                        "login",
                        member.repository.name,
                        member.user.id,
                        signal,
                    );
                    next = saved === null ? { kind: "intro", outcome: null } : await observe(saved, signal);
                    break;
                }
                case "intro":
                case "starting":
                    return;
                case "waiting":
                case "authorizing":
                case "completing":
                case "publishing":
                    next = await observe(phase.session, signal);
                    break;
                default:
                    return phase satisfies never;
            }
            set({ phase: next, problem: null });
        };

        const loop = async (signal: AbortSignal): Promise<void> => {
            while (!signal.aborted) {
                try {
                    await work.run(synchronize);
                } catch (cause) {
                    const error = toAppError(cause);
                    if (error.code === "cancelled") {
                        return;
                    }
                    set({ problem: error.code });
                }
                wake = new AbortController();
                try {
                    await member.clock.sleep(POLL_MS, AbortSignal.any([signal, wake.signal]));
                } catch {
                    /* Woken early by a command, or closed. */
                }
            }
        };

        const command = (name: Exclude<SharingCommand, null>, task: (signal: AbortSignal) => Promise<void>) => {
            if (get().command !== null || work.signal === null) {
                return;
            }
            set({ command: name, commandError: null });
            work.run(task).then(
                () => {
                    set({ command: null });
                    wake?.abort();
                },
                (cause: unknown) => {
                    const error = toAppError(cause);
                    if (error.code !== "cancelled") {
                        set({ command: null, commandError: error.code });
                        wake?.abort();
                    }
                },
            );
        };

        return {
            phase: { kind: "loading" },
            command: null,
            problem: null,
            commandError: null,
            open: () => {
                void loop(work.open());
            },
            close: () => {
                work.close();
            },
            start: () =>
                command("start", async (signal) => {
                    const phase = get().phase;
                    if (phase.kind !== "intro") {
                        return;
                    }
                    // Fail before any run starts if this token cannot write repository secrets.
                    await member.github.secretPublicKey(member.repository.name, signal);
                    if ((await member.github.activeSessions(member.repository.name, member.user, signal)).length > 0) {
                        throw new AppError("session_busy");
                    }
                    set({ phase: { kind: "starting" } });
                    try {
                        set({ phase: { kind: "waiting", session: await beginSession(member, "login", signal) } });
                    } catch (cause) {
                        set({ phase });
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
                    if (phase.kind !== "waiting" && phase.kind !== "authorizing" && phase.kind !== "completing") {
                        return;
                    }
                    const observation = await observeSession(member, phase.session, schemas, signal);
                    if (observation.kind === "queued" || observation.kind === "running") {
                        await member.github.cancelRun(member.repository.name, observation.run.id, signal);
                    }
                    await abandonSession(member, phase.session);
                    set({ phase: { kind: "intro", outcome: { kind: "cancelled" } } });
                }),
        };
    });
}
