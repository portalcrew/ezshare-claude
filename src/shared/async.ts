import { AppError, throwIfCancelled } from "./errors.ts";

/** Time as a port, so polling and expiry follow an injected clock. */
export interface Clock {
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export const systemClock: Clock = {
    now: () => Date.now(),
    sleep: (milliseconds, signal) => {
        if (signal.aborted) {
            return Promise.reject(new AppError("cancelled", { cause: signal.reason }));
        }
        return new Promise((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(new AppError("cancelled", { cause: signal.reason }));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, milliseconds);
            signal.addEventListener("abort", abort, { once: true });
        });
    },
};

/**
 * Runs a finite operation under the caller's cancellation and its own deadline.
 * Cancellation by the caller stays `cancelled`; expiry of the deadline becomes `timeout`.
 */
export async function withDeadline<T>(
    milliseconds: number,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    throwIfCancelled(signal);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
    try {
        return await operation(AbortSignal.any([signal, deadline.signal]));
    } catch (cause) {
        if (signal.aborted) {
            throw new AppError("cancelled", { cause });
        }
        if (deadline.signal.aborted) {
            throw new AppError("timeout", { cause });
        }
        throw cause;
    } finally {
        clearTimeout(timer);
    }
}

/** A signal for best-effort cleanup that must run after the operation's own signal was aborted. */
export function cleanupSignal(milliseconds: number): AbortSignal {
    return AbortSignal.timeout(milliseconds);
}
