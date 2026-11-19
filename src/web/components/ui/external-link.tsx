import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";
import { focusRing } from "./button.tsx";

/** A link that opens outside the launcher and says so to assistive technology. */
export function ExternalLink({
    href,
    children,
    prominent = false,
    outlined = false,
    destination = "browser",
}: {
    readonly href: string;
    readonly children: ReactNode;
    readonly prominent?: boolean;
    /** One of several equal choices: shaped like a button without claiming the page's main action. */
    readonly outlined?: boolean;
    readonly destination?: "browser" | "application";
}) {
    return (
        <a
            href={href}
            target={destination === "browser" ? "_blank" : undefined}
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={cn(
                focusRing,
                prominent
                    ? "inline-flex min-h-11 items-center justify-center rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink/85 active:bg-ink/75 motion-reduce:transition-none"
                    : outlined
                      ? "inline-flex min-h-11 items-center justify-center rounded-full border border-hairline px-5 py-2 text-sm font-medium text-ink transition-colors hover:bg-fill active:bg-fill-strong motion-reduce:transition-none"
                      : "rounded-sm font-medium text-accent underline-offset-4 hover:underline",
            )}
        >
            {children}
            <span className="sr-only">
                {destination === "browser" ? " (opens in a new tab)" : " (opens an external application)"}
            </span>
        </a>
    );
}
