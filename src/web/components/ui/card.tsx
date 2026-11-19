import type { ReactNode } from "react";

/** A titled surface. The optional status line above the title says what state the content is in. */
export function Card({
    title,
    status,
    children,
}: {
    readonly title: string;
    readonly status?: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <section aria-label={title} className="rounded-[24px] bg-white p-6 shadow-module sm:p-7">
            {status}
            <h2 className="text-[22px] leading-[30px] font-semibold tracking-[-0.01em]">{title}</h2>
            <div className="mt-3 space-y-4">{children}</div>
        </section>
    );
}

const dots = {
    idle: "bg-ink-4",
    busy: "bg-accent motion-safe:animate-pulse",
    ok: "bg-ok",
    warn: "bg-[oklch(0.75_0.15_75)]",
} as const;

/** A dot and a few words naming the state, e.g. "Asleep" or "Awake · 3 h 41 min left". */
export function StatusLine({ tone, children }: { readonly tone: keyof typeof dots; readonly children: ReactNode }) {
    return (
        <p className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink-2">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dots[tone]}`} />
            {children}
        </p>
    );
}
