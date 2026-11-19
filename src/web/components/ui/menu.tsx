import { type ReactNode, useEffect, useRef, useState } from "react";
import { focusRing } from "./button.tsx";

/**
 * A button that opens a short list of actions. It closes on Escape, on a press outside it, and after an item is
 * chosen, then returns focus to the button.
 */
export function Menu({
    label,
    trigger,
    children,
}: {
    readonly label: string;
    readonly trigger: ReactNode;
    readonly children: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const close = () => {
        setOpen(false);
        button.current?.focus();
    };

    useEffect(() => {
        if (!open) {
            return;
        }
        const listeners = new AbortController();
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (event.target instanceof Node && !root.current?.contains(event.target)) {
                    setOpen(false);
                }
            },
            { signal: listeners.signal },
        );
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") {
                    setOpen(false);
                    button.current?.focus();
                }
            },
            { signal: listeners.signal },
        );
        root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        return () => listeners.abort();
    }, [open]);

    return (
        <div ref={root} className="relative">
            <button
                ref={button}
                type="button"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={`${focusRing} flex size-10 items-center justify-center rounded-full bg-fill text-[13px] font-semibold text-ink-2 transition-colors hover:bg-fill-strong`}
            >
                {trigger}
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label={label}
                    className="absolute top-12 right-0 z-10 w-64 rounded-[24px] border border-white bg-white p-1.5 shadow-floating"
                >
                    {children(close)}
                </div>
            )}
        </div>
    );
}

export function MenuItem({
    onSelect,
    tone = "default",
    children,
}: {
    readonly onSelect: () => void;
    readonly tone?: "default" | "danger";
    readonly children: ReactNode;
}) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onSelect}
            className={`${focusRing} flex min-h-11 w-full items-center rounded-[14px] px-3 text-left text-sm font-medium transition-colors hover:bg-fill ${tone === "danger" ? "text-danger" : "text-ink-2 hover:text-ink"}`}
        >
            {children}
        </button>
    );
}

export function MenuSeparator() {
    return <hr className="mx-3 my-1 h-px border-0 bg-black/[0.06]" />;
}
