import { useRef, useState } from "react";
import { Button } from "./ui/button.tsx";

/** A read-only value with clipboard feedback and a manual-copy fallback. */
export function CopyField({
    value,
    label,
    action,
    copied,
    manual,
}: {
    readonly value: string;
    readonly label: string;
    readonly action: string;
    readonly copied: string;
    readonly manual: string;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
    return (
        <div className="space-y-2">
            <label className="grid gap-2 text-sm font-medium">
                {label}
                <input
                    ref={input}
                    value={value}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-h-11 min-w-0 rounded-[14px] border border-hairline bg-canvas px-3 font-mono text-xs"
                />
            </label>
            <Button
                variant="secondary"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(value);
                        setStatus("copied");
                    } catch {
                        input.current?.focus();
                        input.current?.select();
                        setStatus("manual");
                    }
                }}
            >
                {action}
            </Button>
            <p role="status" className="text-sm text-ink-3">
                {status === "copied" ? copied : status === "manual" ? manual : ""}
            </p>
        </div>
    );
}
