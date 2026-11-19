import type { ComponentProps, MouseEvent } from "react";
import { cn } from "../utils/cn.ts";

const variants = {
    primary: "bg-ink text-white hover:bg-ink/85 active:bg-ink/75",
    secondary: "border border-hairline bg-transparent text-ink hover:bg-fill active:bg-fill-strong",
    danger: "bg-danger text-white hover:bg-danger/90 active:bg-danger/80",
    quiet: "px-0 text-ink-2 underline decoration-ink-4 underline-offset-4 hover:text-ink",
} as const;

export const focusRing =
    "outline-none focus-visible:outline-[0.5px] focus-visible:outline-accent focus-visible:shadow-[0_0_0_3px_rgba(79,124,255,0.2)]";

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
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors motion-reduce:transition-none",
                focusRing,
                variants[variant],
                inactive && "cursor-not-allowed opacity-50",
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
