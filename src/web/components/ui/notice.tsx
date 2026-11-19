import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";

const tones = {
    info: "border-accent/20 bg-accent-subtle text-[#2f4fb8]",
    success: "border-ok/25 bg-ok/10 text-[oklch(0.45_0.11_155)]",
    warning: "border-[oklch(0.62_0.14_75/0.18)] bg-[oklch(0.98_0.03_85/0.8)] text-[oklch(0.48_0.12_70)]",
    error: "border-danger/20 bg-[oklch(0.97_0.02_27/0.7)] text-danger",
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
            className={cn("rounded-[16px] border px-4 py-3 text-sm", tones[tone])}
        >
            {title !== undefined && <p className="font-medium">{title}</p>}
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
