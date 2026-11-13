import { createStore } from "zustand/vanilla";
import { AppError, type ErrorCode, toAppError } from "../../shared/errors.ts";
import type { WorkflowRun } from "../../shared/github/client.ts";
import {
    type ChatBrowserMessage,
    type ChatRunnerMessage,
    chatBrowserMessageSchema,
    chatRunnerMessageSchema,
    type HistoryEnd,
    type HistoryStart,
    mortyUrl,
} from "../../shared/protocol.ts";
import type { PendingSession } from "../services/vault.ts";
import { SerialWork } from "./serial-work.ts";
import {
    abandonSession,
    beginSession,
    type MemberContext,
    observeSession,
    requireRun,
    sessionExpired,
} from "./session-protocol.ts";

const POLL_STARTING_MS = 5_000;
const POLL_READY_MS = 30_000;
const POLL_IDLE_MS = 30_000;

/** How the member's previous session ended, shown until the next one starts. */
export type ChatOutcome =
    | { readonly kind: "stopped"; readonly history: HistoryEnd }
    | { readonly kind: "expired" }
    | { readonly kind: "failed"; readonly code: ErrorCode };

export type ChatPhase =
    | { readonly kind: "loading" }
    | { readonly kind: "idle"; readonly outcome: ChatOutcome | null }
    | { readonly kind: "busy"; readonly runs: readonly WorkflowRun[] }
    | { readonly kind: "starting" }
    | { readonly kind: "queued"; readonly session: PendingSession }
    | { readonly kind: "preparing"; readonly session: PendingSession }
    | {
          readonly kind: "ready";
          readonly session: PendingSession;
          readonly url: string;
          readonly accessExpiresAt: string;
          readonly history: HistoryStart;
      }
    | { readonly kind: "stopping"; readonly session: PendingSession; readonly forced: boolean };

/** User commands in flight; the view disables the matching controls. */
export type ChatCommand = "start" | "stop" | "force_stop" | "cancel_run" | "replace_history" | null;

export interface ChatState {
    readonly phase: ChatPhase;
    readonly command: ChatCommand;
    /** The last refresh failed; the phase is the last confirmed one. */
    readonly problem: ErrorCode | null;
    /** The last command failed; the phase did not change. */
    readonly commandError: ErrorCode | null;
    /** The next session will save its history over an archive this browser cannot read. */
    readonly replacingHistory: boolean;
}

export interface ChatActions {
    readonly open: () => void;
    readonly close: () => void;
    readonly start: () => void;
    readonly stop: () => void;
    readonly forceStop: () => void;
    readonly cancelRun: (runId: string) => void;
    /** Lets the next session replace a saved history this browser cannot read. */
    readonly replaceHistory: () => void;
    readonly refresh: () => void;
}

export type ChatStore = ReturnType<typeof createChatStore>;

/** The member's personal Claude session: start, observe, hand over the chat link, stop. */
export function createChatStore(member: MemberContext) {
    const work = new SerialWork();
    let wake: AbortController | null = null;
    // A session that reported its end may still be cleaning up; it is not another unfinished session.
    let ending: string | null = null;
    // Sessions this page has handed its history key to; the runner keeps the first key it receives.
    const keyed = new Set<string>();

    return createStore<ChatState & ChatActions>()((set, get) => {
        const observe = async (session: PendingSession, signal: AbortSignal): Promise<ChatPhase> => {
            if (sessionExpired(member, session)) {
                await abandonSession(member, session);
                return { kind: "idle", outcome: { kind: "expired" } };
            }
            const observation = await observeSession(
                member,
                session,
                { outbound: chatBrowserMessageSchema, inbound: chatRunnerMessageSchema },
                signal,
            );
            const current = get().phase;
            const stopping = current.kind === "stopping" ? current : null;
            // A cancel requested before the run was visible is carried out as soon as it is.
            if (stopping?.forced === true && (observation.kind === "queued" || observation.kind === "running")) {
                await member.github.cancelRun(member.repository.name, observation.run.id, signal);
            }
            switch (observation.kind) {
                case "not_started":
                    if (observation.overdue) {
                        await abandonSession(member, session);
                        return { kind: "idle", outcome: { kind: "failed", code: "github_unavailable" } };
                    }
                    return stopping ?? { kind: "queued", session };
                case "queued":
                    return stopping ?? { kind: "queued", session };
                case "running":
                case "finished": {
                    const messages = observation.channel === null ? [] : await observation.channel.receive(signal);
                    const outcome = outcomeOf(messages, observation.kind === "finished");
                    if (outcome !== null) {
                        ending = observation.kind === "running" ? observation.run.id : null;
                        keyed.delete(session.requestId);
                        if (outcome.kind === "stopped" && outcome.history === "archived") {
                            await member.vault.setHistoryMode(
                                member.repository.name,
                                member.user.id,
                                "continue",
                                signal,
                            );
                        }
                        await abandonSession(member, session);
                        return { kind: "idle", outcome };
                    }
                    if (
                        observation.kind === "running" &&
                        observation.channel !== null &&
                        stopping === null &&
                        !keyed.has(session.requestId) &&
                        !messages.some((message) => message.kind === "ready")
                    ) {
                        const history = await member.vault.history(member.repository.name, member.user.id, signal);
                        const message: ChatBrowserMessage = { kind: "history", body: history };
                        await observation.channel.send(message, signal);
                        keyed.add(session.requestId);
                    }
                    if (stopping !== null) {
                        return stopping;
                    }
                    const ready = messages.findLast((message) => message.kind === "ready");
                    if (ready !== undefined) {
                        return {
                            kind: "ready",
                            session,
                            url: mortyUrl(ready.body.url),
                            accessExpiresAt: ready.body.accessExpiresAt,
                            history: ready.body.history,
                        };
                    }
                    return { kind: "preparing", session };
                }
                default:
                    return observation satisfies never;
            }
        };

        const synchronize = async (signal: AbortSignal): Promise<void> => {
            const phase = get().phase;
            let next: ChatPhase;
            switch (phase.kind) {
                case "loading": {
                    const saved = await member.vault.loadPending(
                        "chat",
                        member.repository.name,
                        member.user.id,
                        signal,
                    );
                    next = saved === null ? await idleOrBusy(null, signal) : await observe(saved, signal);
                    break;
                }
                case "idle":
                case "busy":
                    next = await idleOrBusy(phase.kind === "idle" ? phase.outcome : null, signal);
                    break;
                case "starting":
                    return;
                case "queued":
                case "preparing":
                case "ready":
                case "stopping":
                    next = await observe(phase.session, signal);
                    if (next.kind === "idle") {
                        next = await idleOrBusy(next.outcome, signal);
                    }
                    break;
                default:
                    return phase satisfies never;
            }
            const history = await member.vault.history(member.repository.name, member.user.id, signal);
            set({ phase: next, problem: null, replacingHistory: history.mode === "replace" });
        };

        const idleOrBusy = async (outcome: ChatOutcome | null, signal: AbortSignal): Promise<ChatPhase> => {
            const runs = (await member.github.activeSessions(member.repository.name, member.user, signal)).filter(
                (run) => run.id !== ending,
            );
            if (runs.length === 0) {
                ending = null;
            }
            return runs.length === 0 ? { kind: "idle", outcome } : { kind: "busy", runs };
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
                    await member.clock.sleep(interval(get()), AbortSignal.any([signal, wake.signal]));
                } catch {
                    /* Woken early by a command, or closed. */
                }
            }
        };

        const command = (name: Exclude<ChatCommand, null>, task: (signal: AbortSignal) => Promise<void>) => {
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
                    if (error.code === "cancelled") {
                        return;
                    }
                    set({ command: null, commandError: error.code });
                    wake?.abort();
                },
            );
        };

        const runOf = async (session: PendingSession, signal: AbortSignal) =>
            requireRun(
                await observeSession(
                    member,
                    session,
                    { outbound: chatBrowserMessageSchema, inbound: chatRunnerMessageSchema },
                    signal,
                ),
            );

        return {
            phase: { kind: "loading" },
            command: null,
            problem: null,
            commandError: null,
            replacingHistory: false,
            open: () => {
                void loop(work.open());
            },
            close: () => {
                work.close();
            },
            refresh: () => {
                wake?.abort();
            },
            start: () =>
                command("start", async (signal) => {
                    const phase = get().phase;
                    if (phase.kind !== "idle") {
                        return;
                    }
                    if ((await member.github.activeSessions(member.repository.name, member.user, signal)).length > 0) {
                        throw new AppError("session_busy");
                    }
                    set({ phase: { kind: "starting" } });
                    try {
                        set({ phase: { kind: "queued", session: await beginSession(member, "chat", signal) } });
                    } catch (cause) {
                        set({ phase });
                        throw cause;
                    }
                }),
            stop: () =>
                command("stop", async (signal) => {
                    const phase = get().phase;
                    if (phase.kind !== "ready" && phase.kind !== "preparing" && phase.kind !== "queued") {
                        return;
                    }
                    const observation = await observeSession(
                        member,
                        phase.session,
                        { outbound: chatBrowserMessageSchema, inbound: chatRunnerMessageSchema },
                        signal,
                    );
                    if (observation.kind === "running" && observation.channel !== null) {
                        const stop: ChatBrowserMessage = { kind: "stop", body: {} };
                        await observation.channel.send(stop, signal);
                        set({ phase: { kind: "stopping", session: phase.session, forced: false } });
                        return;
                    }
                    // Nothing listens for a stop message yet: end the run instead.
                    if (observation.kind === "queued" || observation.kind === "running") {
                        await member.github.cancelRun(member.repository.name, observation.run.id, signal);
                    }
                    set({ phase: { kind: "stopping", session: phase.session, forced: true } });
                }),
            forceStop: () =>
                command("force_stop", async (signal) => {
                    const phase = get().phase;
                    if (phase.kind === "loading" || phase.kind === "idle" || phase.kind === "busy") {
                        return;
                    }
                    if (phase.kind === "starting") {
                        return;
                    }
                    const run = await runOf(phase.session, signal);
                    if (run.status !== "completed") {
                        await member.github.cancelRun(member.repository.name, run.id, signal);
                    }
                    set({ phase: { kind: "stopping", session: phase.session, forced: true } });
                }),
            replaceHistory: () =>
                command("replace_history", async (signal) => {
                    await member.vault.setHistoryMode(member.repository.name, member.user.id, "replace", signal);
                    set({ replacingHistory: true });
                }),
            cancelRun: (runId) =>
                command("cancel_run", async (signal) => {
                    const phase = get().phase;
                    // Only a run the member owns, verified just now, can be cancelled from here.
                    const owned = await member.github.activeSessions(member.repository.name, member.user, signal);
                    if (phase.kind !== "busy" || !owned.some((run) => run.id === runId)) {
                        // The last rendered run may have finished while the member was clicking End run.
                        await synchronize(signal);
                        return;
                    }
                    await member.github.cancelRun(member.repository.name, runId, signal);
                }),
        };
    });
}

function outcomeOf(
    messages: readonly (ChatRunnerMessage & { readonly sequence: number })[],
    finished: boolean,
): ChatOutcome | null {
    const failure = messages.find((message) => message.kind === "failed");
    if (failure !== undefined) {
        return { kind: "failed", code: failure.body.code };
    }
    const stopped = messages.find((message) => message.kind === "stopped");
    if (stopped !== undefined) {
        return { kind: "stopped", history: stopped.body.history };
    }
    if (finished) {
        return { kind: "stopped", history: "not_archived" };
    }
    return null;
}

function interval(state: ChatState): number {
    if (state.problem !== null) {
        return POLL_STARTING_MS * 3;
    }
    switch (state.phase.kind) {
        case "loading":
        case "starting":
        case "queued":
        case "preparing":
        case "stopping":
            return POLL_STARTING_MS;
        case "ready":
            return POLL_READY_MS;
        case "idle":
        case "busy":
            return POLL_IDLE_MS;
        default:
            return state.phase satisfies never;
    }
}
