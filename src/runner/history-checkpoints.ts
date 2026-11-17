import { appendFile } from "node:fs/promises";
import { type Clock, cleanupSignal, withDeadline } from "../shared/async.ts";
import { toAppError } from "../shared/errors.ts";
import type { HistoryEnd } from "../shared/protocol.ts";
import { type ActionsContext, agentWorkspace, historyArchivePath } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { latestSessionId, saveHistory } from "./history-archive.ts";
import type { HistoryCache } from "./history-cache.ts";

const INTERVAL_MS = 5 * 60_000;
const SAVE_TIMEOUT_MS = 6 * 60_000;

export interface SavingHistory {
    readonly key: string;
    readonly sessionId: string;
}

/** Serial encrypted uploads, running independently of chat polling and joined before final shutdown. */
export class HistoryCheckpoints {
    readonly #context: ActionsContext;
    readonly #path: string;
    readonly #ports: { readonly clock: Clock; readonly diagnostics: Diagnostics; readonly cache: HistoryCache };
    readonly #uploaded: string[] = [];
    #sequence = 0;

    constructor(
        context: ActionsContext,
        path: string,
        ports: { readonly clock: Clock; readonly diagnostics: Diagnostics; readonly cache: HistoryCache },
    ) {
        this.#context = context;
        this.#path = path;
        this.#ports = ports;
    }

    readonly during = async (
        saving: SavingHistory | null,
        work: () => Promise<void>,
        signal: AbortSignal,
    ): Promise<void> => {
        const ending = new AbortController();
        const lifetime = AbortSignal.any([signal, ending.signal]);
        const background = saving === null ? Promise.resolve() : this.#loop(saving, lifetime);
        try {
            await work();
        } finally {
            ending.abort(new DOMException("Session ending", "AbortError"));
            await background;
        }
    };

    readonly finish = async (saving: SavingHistory | null): Promise<HistoryEnd> => {
        if (saving === null) {
            return "not_archived";
        }
        this.#ports.diagnostics({ event: "session.stage", stage: "saving_history" });
        try {
            await withDeadline(
                SAVE_TIMEOUT_MS,
                cleanupSignal(SAVE_TIMEOUT_MS),
                (signal) => this.#save(saving, signal, true),
                this.#ports.clock,
            );
            return "archived";
        } catch (cause) {
            this.#failed(cause);
            return "not_archived";
        }
    };

    readonly #loop = async (saving: SavingHistory, signal: AbortSignal): Promise<void> => {
        while (!signal.aborted) {
            try {
                await withDeadline(
                    SAVE_TIMEOUT_MS,
                    signal,
                    (bounded) => this.#save(saving, bounded),
                    this.#ports.clock,
                );
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                this.#failed(cause);
            }
            try {
                await this.#ports.clock.sleep(INTERVAL_MS, signal);
            } catch {
                return;
            }
        }
    };

    readonly #failed = (cause: unknown): void => {
        this.#ports.diagnostics({
            event: "history.checkpoint",
            outcome: "failed",
            sequence: this.#sequence,
            code: toAppError(cause).code,
        });
    };

    readonly #save = async (saving: SavingHistory, signal: AbortSignal, final = false): Promise<void> => {
        this.#sequence += 1;
        const context = this.#context;
        const archive = historyArchivePath(context.runnerTemp);
        const sessionId = await latestSessionId(
            context.agent,
            this.#path,
            agentWorkspace(context.agent),
            saving.sessionId,
            signal,
        );
        await saveHistory(
            archive,
            saving.key,
            { repository: context.repository, userId: context.userId },
            context.agent,
            this.#path,
            sessionId,
            signal,
        );
        if (final) {
            // The workflow's final cache action remains a fallback if this upload fails.
            await appendFile(context.githubOutput, "history=archived\n");
        }
        const key = `ezshare-history-${context.userId}-run-${context.runId}-checkpoint-${crypto.randomUUID()}`;
        await this.#ports.cache.save(key, archive, signal);
        this.#uploaded.push(key);
        this.#ports.diagnostics({ event: "history.checkpoint", outcome: "saved", sequence: this.#sequence });
        if (this.#uploaded.length > 2) {
            const previous = this.#uploaded.shift();
            if (previous !== undefined) {
                try {
                    await this.#ports.cache.remove(previous, signal);
                } catch (cause) {
                    this.#ports.diagnostics({
                        event: "history.checkpoint",
                        outcome: "cleanup_failed",
                        sequence: this.#sequence,
                        code: toAppError(cause).code,
                    });
                }
            }
        }
    };
}
