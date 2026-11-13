import { createStore } from "zustand/vanilla";
import type { SessionChannel } from "../../shared/channel.ts";
import { AppError, type ErrorCode } from "../../shared/errors.ts";
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
import {
    abandonSession,
    beginSession,
    type MemberContext,
    observeSession,
    requireRun,
    sessionExpired,
} from "./session-protocol.ts";
import { StoreWorkflow } from "./store-workflow.ts";

const POLL_STARTING_MS = 5_000;
const POLL_READY_MS = 30_000;
const POLL_IDLE_MS = 30_000;
/** Polling slows down while GitHub keeps failing. */
const POLL_PROBLEM_MS = 15_000;

const schemas = { outbound: chatBrowserMessageSchema, inbound: chatRunnerMessageSchema };
type ChatChannel = SessionChannel<typeof chatBrowserMessageSchema, typeof chatRunnerMessageSchema>;

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
    // A session that reported its end may still be cleaning up; it is not another unfinished session.
    let ending: string | null = null;
    // Sessions this page has handed its history key to; the runner keeps the first key it receives.
    const keyed = new Set<string>();

    return createStore<ChatState & ChatActions>()((set, get) => {
        /** The session is over for this page: forget its key and show how it ended. */
        const finish = async (session: PendingSession, outcome: ChatOutcome): Promise<ChatPhase> => {
            await abandonSession(member, session);
            return { kind: "idle", outcome };
        };

        /** The runner reported its end: keep a saved history for the next session, then finish. */
        const finishReported = async (
            session: PendingSession,
            outcome: ChatOutcome,
            stillRunning: string | null,
            signal: AbortSignal,
        ): Promise<ChatPhase> => {
            ending = stillRunning;
            keyed.delete(session.requestId);
            if (outcome.kind === "stopped" && outcome.history === "archived") {
                await member.vault.setHistoryMode(member.repository.name, member.user.id, "continue", signal);
            }
            return finish(session, outcome);
        };

        /** Sends this browser's history key to a running session once, until it reports ready. */
        const handOverHistoryKey = async (
            session: PendingSession,
            channel: ChatChannel,
            messages: readonly ChatRunnerMessage[],
            signal: AbortSignal,
        ): Promise<void> => {
            if (keyed.has(session.requestId) || messages.some((message) => message.kind === "ready")) {
                return;
            }
            const history = await member.vault.history(member.repository.name, member.user.id, signal);
            const message: ChatBrowserMessage = { kind: "history", body: history };
            await channel.send(message, signal);
            keyed.add(session.requestId);
        };

        /**
         * Moves a pending session one step forward and returns the phase to show. Besides reading the run, this
         * acts on what it finds: it carries out a cancel requested before the run was visible, hands over the
         * history key, and finishes a session that ended.
         */
        const advance = async (session: PendingSession, signal: AbortSignal): Promise<ChatPhase> => {
            if (sessionExpired(member, session)) {
                return finish(session, { kind: "expired" });
            }
            const observation = await observeSession(member, session, schemas, signal);
            const current = get().phase;
            const stopping = current.kind === "stopping" ? current : null;
            if (stopping?.forced === true && (observation.kind === "queued" || observation.kind === "running")) {
                await member.github.cancelRun(member.repository.name, observation.run.id, signal);
            }
            switch (observation.kind) {
                case "not_started":
                    if (observation.overdue) {
                        return finish(session, { kind: "failed", code: "github_unavailable" });
                    }
                    return stopping ?? { kind: "queued", session };
                case "queued":
                    return stopping ?? { kind: "queued", session };
                case "running":
                case "finished": {
                    const messages = observation.channel === null ? [] : await observation.channel.receive(signal);
                    const outcome = outcomeOf(messages, observation.kind === "finished");
                    if (outcome !== null) {
                        const stillRunning = observation.kind === "running" ? observation.run.id : null;
                        return finishReported(session, outcome, stillRunning, signal);
                    }
                    if (observation.kind === "running" && observation.channel !== null && stopping === null) {
                        await handOverHistoryKey(session, observation.channel, messages, signal);
                    }
                    return stopping ?? progressOf(session, messages);
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
                    next = saved === null ? await idleOrBusy(null, signal) : await advance(saved, signal);
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
                    next = await advance(phase.session, signal);
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

        const workflow = new StoreWorkflow<Exclude<ChatCommand, null>>({
            clock: member.clock,
            synchronize,
            interval: () => interval(get()),
            currentCommand: () => get().command,
            reportProblem: (problem) => set({ problem }),
            commandStarted: (command) => set({ command, commandError: null }),
            commandFinished: (error) =>
                set(error === null ? { command: null } : { command: null, commandError: error }),
        });
        const command = workflow.command;

        return {
            phase: { kind: "loading" },
            command: null,
            problem: null,
            commandError: null,
            replacingHistory: false,
            open: workflow.open,
            close: workflow.close,
            refresh: workflow.refresh,
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
                    const observation = await observeSession(member, phase.session, schemas, signal);
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
                    if (
                        phase.kind === "loading" ||
                        phase.kind === "idle" ||
                        phase.kind === "busy" ||
                        phase.kind === "starting"
                    ) {
                        return;
                    }
                    const run = requireRun(await observeSession(member, phase.session, schemas, signal));
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

/** A running session is ready once the runner sent its chat link; until then it is preparing. */
function progressOf(session: PendingSession, messages: readonly ChatRunnerMessage[]): ChatPhase {
    const ready = messages.findLast((message) => message.kind === "ready");
    return ready === undefined
        ? { kind: "preparing", session }
        : { kind: "ready", session, url: mortyUrl(ready.body.url), history: ready.body.history };
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
        return POLL_PROBLEM_MS;
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
