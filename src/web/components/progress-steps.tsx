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
        <ol aria-label={label} className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {steps.map((step, index) => (
                <li
                    key={step}
                    aria-current={index === current ? "step" : undefined}
                    className={cn(
                        "flex items-center gap-2",
                        index < current && "text-stone-500 dark:text-stone-400",
                        index === current && "font-semibold text-emerald-800 dark:text-emerald-300",
                    )}
                >
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-2 rounded-full",
                            index <= current ? "bg-emerald-600" : "bg-stone-300 dark:bg-stone-600",
                        )}
                    />
                    {step}
                    {index < current && <span className="sr-only"> (done)</span>}
                </li>
            ))}
        </ol>
    );
}
