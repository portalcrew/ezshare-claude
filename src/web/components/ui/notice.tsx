import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";

const tones = {
    info: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
    success:
        "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
    warning: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
    error: "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
} as const;

/** A message box. Errors are announced immediately; other tones are read in document order. */
export function Notice({
    tone,
    title,
    children,
}: {
    readonly tone: keyof typeof tones;
    readonly title?: string;
    readonly children: ReactNode;
}) {
    return (
        <div
            role={tone === "error" ? "alert" : undefined}
            className={cn("rounded-lg border px-4 py-3 text-sm", tones[tone])}
        >
            {title !== undefined && <p className="font-semibold">{title}</p>}
            <div className={cn(title !== undefined && "mt-1")}>{children}</div>
        </div>
    );
}

/** A visually hidden live region that announces short status changes. */
export function Announcer({ message }: { readonly message: string }) {
    return (
        <p role="status" className="sr-only">
            {message}
        </p>
    );
}
