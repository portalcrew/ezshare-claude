import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";
import { focusRing } from "./button.tsx";

/** A link that opens outside the launcher and says so to assistive technology. */
export function ExternalLink({
    href,
    children,
    prominent = false,
}: {
    readonly href: string;
    readonly children: ReactNode;
    readonly prominent?: boolean;
}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={cn(
                focusRing,
                prominent
                    ? "inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                    : "rounded-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950 dark:text-emerald-300 dark:hover:text-emerald-200",
            )}
        >
            {children}
            <span className="sr-only"> (opens in a new tab)</span>
        </a>
    );
}
