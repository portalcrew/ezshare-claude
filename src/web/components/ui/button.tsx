import type { ComponentProps, MouseEvent } from "react";
import { cn } from "../utils/cn.ts";

const variants = {
    primary:
        "bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400",
    secondary:
        "border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
    danger: "bg-red-700 text-white hover:bg-red-800 dark:bg-red-500 dark:text-red-950 dark:hover:bg-red-400",
    quiet: "px-0 text-stone-600 underline underline-offset-4 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white",
} as const;

export const focusRing =
    "outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-600/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950";

/**
 * A button that stays focusable while busy: `aria-disabled` keeps it in the tab order and announced, and clicks
 * are ignored, so focus is not lost when an action starts.
 */
export function Button({
    variant = "primary",
    busy = false,
    className,
    onClick,
    children,
    ...props
}: Readonly<ComponentProps<"button">> & {
    readonly variant?: keyof typeof variants;
    readonly busy?: boolean;
}) {
    const inactive = busy || props.disabled === true;
    return (
        <button
            type="button"
            {...props}
            disabled={undefined}
            aria-disabled={inactive || undefined}
            aria-busy={busy || undefined}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
                if (!inactive) {
                    onClick?.(event);
                }
            }}
            className={cn(
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors motion-reduce:transition-none",
                focusRing,
                variants[variant],
                inactive && "cursor-not-allowed opacity-60",
                className,
            )}
        >
            {busy && (
                <span
                    aria-hidden="true"
                    className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                />
            )}
            {children}
        </button>
    );
}
