import type { ReactNode } from "react";

export function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
    return (
        <section
            aria-label={title}
            className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-900"
        >
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <div className="mt-4 space-y-4">{children}</div>
        </section>
    );
}
