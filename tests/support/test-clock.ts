import type { Clock } from "../../src/shared/async.ts";
import { AppError } from "../../src/shared/errors.ts";

interface Sleeper {
    readonly due: number;
    readonly resolve: () => void;
}

/** A clock that moves only when a test advances it. Sleeps resolve in due order. */
export class TestClock implements Clock {
    #now: number;
    #sleepers: Sleeper[] = [];

    constructor(iso: string) {
        this.#now = Date.parse(iso);
    }

    readonly now = (): number => this.#now;

    readonly sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
        if (signal.aborted) {
            return Promise.reject(new AppError("cancelled"));
        }
        return new Promise((resolve, reject) => {
            const sleeper: Sleeper = {
                due: this.#now + milliseconds,
                resolve: () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
            };
            const abort = () => {
                this.#sleepers = this.#sleepers.filter((candidate) => candidate !== sleeper);
                reject(new AppError("cancelled"));
            };
            signal.addEventListener("abort", abort, { once: true });
            this.#sleepers.push(sleeper);
        });
    };

    readonly advance = (milliseconds: number): void => {
        this.#now += milliseconds;
        const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#now).sort((a, b) => a.due - b.due);
        this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#now);
        for (const sleeper of due) {
            sleeper.resolve();
        }
    };
}
