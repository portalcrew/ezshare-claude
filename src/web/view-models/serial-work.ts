import { AppError } from "../../shared/errors.ts";

/**
 * Runs a store's GitHub work one task at a time inside an explicitly opened lifetime.
 * Closing aborts the running task and rejects every queued one.
 */
export class SerialWork {
    #lifetime: AbortController | null = null;
    #tail: Promise<void> = Promise.resolve();

    get signal(): AbortSignal | null {
        return this.#lifetime?.signal ?? null;
    }

    readonly open = (): AbortSignal => {
        this.#lifetime?.abort(new DOMException("Replaced", "AbortError"));
        this.#lifetime = new AbortController();
        return this.#lifetime.signal;
    };

    readonly close = (): void => {
        this.#lifetime?.abort(new DOMException("Closed", "AbortError"));
        this.#lifetime = null;
    };

    /** Queues a task; it receives the lifetime's signal and never runs after the lifetime closed. */
    readonly run = <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const signal = this.#lifetime?.signal;
        if (signal === undefined || signal.aborted) {
            return Promise.reject(new AppError("cancelled"));
        }
        const result = this.#tail.then(() => {
            if (signal.aborted) {
                throw new AppError("cancelled", { cause: signal.reason });
            }
            return task(signal);
        });
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
}
