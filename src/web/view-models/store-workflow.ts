import type { Clock } from "../../shared/async.ts";
import { type ErrorCode, toAppError } from "../../shared/errors.ts";
import { SerialWork } from "./serial-work.ts";

/** What a polling store provides to its workflow. The store keeps its state; the workflow only drives it. */
export interface StoreWorkflowPorts<TCommand extends string> {
    readonly clock: Clock;
    /** Refreshes the store's phase from GitHub. */
    readonly synchronize: (signal: AbortSignal) => Promise<void>;
    /** How long to wait before the next refresh. */
    readonly interval: () => number;
    readonly currentCommand: () => TCommand | null;
    /** The last refresh failed. */
    readonly reportProblem: (code: ErrorCode) => void;
    readonly commandStarted: (command: TCommand) => void;
    /** The command finished; `error` is null when it succeeded. */
    readonly commandFinished: (error: ErrorCode | null) => void;
}

/**
 * The lifetime of a polling store: a refresh loop and user commands that share one serial queue. A command wakes
 * the loop when it finishes, so its effect is observed without waiting for the next interval.
 */
export class StoreWorkflow<TCommand extends string> {
    readonly #work = new SerialWork();
    readonly #ports: StoreWorkflowPorts<TCommand>;
    #wake: AbortController | null = null;

    constructor(ports: StoreWorkflowPorts<TCommand>) {
        this.#ports = ports;
    }

    readonly open = (): void => {
        void this.#loop(this.#work.open());
    };

    readonly close = (): void => {
        this.#work.close();
    };

    /** Refreshes now instead of at the end of the current interval. */
    readonly refresh = (): void => {
        this.#wake?.abort();
    };

    /** Runs one user command unless another is in flight or the lifetime is closed. */
    readonly command = (name: TCommand, task: (signal: AbortSignal) => Promise<void>): void => {
        if (this.#ports.currentCommand() !== null || this.#work.signal === null) {
            return;
        }
        this.#ports.commandStarted(name);
        this.#work.run(task).then(
            () => {
                this.#ports.commandFinished(null);
                this.refresh();
            },
            (cause: unknown) => {
                const error = toAppError(cause);
                if (error.code === "cancelled") {
                    return;
                }
                this.#ports.commandFinished(error.code);
                this.refresh();
            },
        );
    };

    readonly #loop = async (signal: AbortSignal): Promise<void> => {
        while (!signal.aborted) {
            try {
                await this.#work.run(this.#ports.synchronize);
            } catch (cause) {
                const error = toAppError(cause);
                if (error.code === "cancelled") {
                    return;
                }
                this.#ports.reportProblem(error.code);
            }
            this.#wake = new AbortController();
            try {
                await this.#ports.clock.sleep(this.#ports.interval(), AbortSignal.any([signal, this.#wake.signal]));
            } catch {
                /* Woken early by a command, or closed. */
            }
        }
    };
}
