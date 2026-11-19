import { cn } from "./utils/cn.ts";

/** An ordered list of steps with the current one marked for assistive technology. */
export function ProgressSteps({
    label,
    steps,
    current,
}: {
    readonly label: string;
    readonly steps: readonly string[];
    readonly current: number;
}) {
    return (
        <ol aria-label={label} className="grid grid-cols-4 gap-1.5 text-[11px] leading-4 text-ink-3">
            {steps.map((step, index) => (
                <li
                    key={step}
                    aria-current={index === current ? "step" : undefined}
                    className={cn("flex flex-col gap-1.5", index === current && "font-medium text-ink")}
                >
                    <span
                        aria-hidden="true"
                        className={cn("h-1 rounded-full", index <= current ? "bg-accent" : "bg-fill-strong")}
                    />
                    {step}
                    {index < current && <span className="sr-only"> (done)</span>}
                </li>
            ))}
        </ol>
    );
}
