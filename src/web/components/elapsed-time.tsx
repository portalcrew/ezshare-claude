import { useEffect, useState } from "react";

/** Seconds since `since`, refreshed every second. Purely visual; it drives no workflow. */
export function ElapsedTime({ since, now }: { readonly since: number; readonly now: () => number }) {
    const [current, setCurrent] = useState(now);
    useEffect(() => {
        const timer = setInterval(() => setCurrent(now()), 1000);
        return () => clearInterval(timer);
    }, [now]);
    const seconds = Math.max(0, Math.floor((current - since) / 1000));
    const minutes = Math.floor(seconds / 60);
    const text = minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
    return <time dateTime={`PT${seconds}S`}>{text}</time>;
}
