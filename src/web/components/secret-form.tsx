import { type FormEvent, useId, useRef } from "react";
import { Button, focusRing } from "./ui/button.tsx";
import { cn } from "./utils/cn.ts";

/**
 * A one-field form for a secret value. The input is uncontrolled and cleared on submit, so the value lives only
 * in the DOM until it is handed to `onSubmit`.
 */
export function SecretForm({
    label,
    hint,
    action,
    busy,
    onSubmit,
}: {
    readonly label: string;
    readonly hint: string;
    readonly action: string;
    readonly busy: boolean;
    readonly onSubmit: (value: string) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const hintId = useId();
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy || input.current === null) {
            return;
        }
        const value = input.current.value;
        input.current.value = "";
        onSubmit(value);
        input.current.focus();
    };
    return (
        <form onSubmit={submit} className="space-y-2">
            <label className="block text-sm font-semibold">
                {label}
                <input
                    ref={input}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    aria-describedby={hintId}
                    className={cn(
                        "mt-1 block min-h-11 w-full rounded-[14px] border border-hairline bg-white px-3 font-mono text-sm",
                        focusRing,
                    )}
                />
            </label>
            <p id={hintId} className="text-sm text-ink-3">
                {hint}
            </p>
            <Button type="submit" busy={busy}>
                {action}
            </Button>
        </form>
    );
}
