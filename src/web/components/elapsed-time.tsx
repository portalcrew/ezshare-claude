import { useEffect, useState } from "react";
import type { Clock } from "../../shared/async.ts";

/** Visual time follows the same clock as the workflow, without driving lifecycle decisions. */
function useCurrentTime(clock: Clock): number {
    const [current, setCurrent] = useState(clock.now);
    useEffect(() => {
        const controller = new AbortController();
        const update = async () => {
            try {
                while (!controller.signal.aborted) {
                    await clock.sleep(1000, controller.signal);
                    controller.signal.throwIfAborted();
                    setCurrent(clock.now());
                }
            } catch (cause) {
                if (!controller.signal.aborted) {
                    throw cause;
                }
            }
        };
        void update();
        return () => controller.abort();
    }, [clock]);
    return current;
}

export function ElapsedTime({ since, clock }: { readonly since: number; readonly clock: Clock }) {
    const current = useCurrentTime(clock);
    const seconds = Math.max(0, Math.floor((current - since) / 1000));
    const minutes = Math.floor(seconds / 60);
    const text = minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
    return <time dateTime={`PT${seconds}S`}>{text}</time>;
}

export function RemainingTime({
    until,
    clock,
    label,
}: {
    readonly until: number;
    readonly clock: Clock;
    readonly label: string;
}) {
    const current = useCurrentTime(clock);
    const minutes = Math.max(0, Math.ceil((until - current) / 60_000));
    const text = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
    return (
        <span role="timer" aria-label={label} aria-live="off">
            {label}: <time dateTime={`PT${minutes}M`}>{text}</time>
        </span>
    );
}
