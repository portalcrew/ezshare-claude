import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type { ConnectionFormCopy, TokenTemplates } from "../view-models/copy.ts";
import { Button, focusRing } from "./ui/button.tsx";
import { ExternalLink } from "./ui/external-link.tsx";
import { cn } from "./utils/cn.ts";

const field =
    "mt-1 block min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm dark:border-stone-600 dark:bg-stone-950";

/** The three connection steps. The repository field is local state so the token links follow it as typed. */
export function ConnectionForm({
    copy,
    initialRepository,
    templatesFor,
    busy,
    onConnect,
}: {
    readonly copy: ConnectionFormCopy;
    readonly initialRepository: string;
    readonly templatesFor: (repository: string) => TokenTemplates | null;
    readonly busy: boolean;
    readonly onConnect: (input: { readonly repository: string; readonly token: string }) => void;
}) {
    const [repository, setRepository] = useState(initialRepository);
    const token = useRef<HTMLInputElement>(null);
    const tokenHint = useId();
    const templates = templatesFor(repository);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy || token.current === null) {
            return;
        }
        const value = token.current.value;
        token.current.value = "";
        onConnect({ repository, token: value });
    };
    return (
        <form onSubmit={submit}>
            <ol className="space-y-6">
                <Step number={1} label={copy.stepLabel(1)} title={copy.repositoryStep}>
                    <label className="block text-sm font-semibold">
                        {copy.repositoryLabel}
                        <input
                            name="repository"
                            value={repository}
                            onChange={(event) => setRepository(event.currentTarget.value)}
                            placeholder={copy.repositoryPlaceholder}
                            autoComplete="off"
                            spellCheck={false}
                            required
                            className={cn(field, focusRing)}
                        />
                    </label>
                </Step>
                <Step number={2} label={copy.stepLabel(2)} title={copy.tokenStep}>
                    {templates === null ? (
                        <p className="text-sm">{copy.noTemplates}</p>
                    ) : (
                        <>
                            <p className="text-sm">
                                {copy.templates.beforeOwner}
                                <strong>{templates.owner}</strong>
                                {copy.templates.afterOwner}
                                <strong>{copy.templates.accessChoice}</strong>
                                {copy.templates.beforeName}
                                <strong>{templates.name}</strong>
                                {copy.templates.afterName}
                            </p>
                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <ExternalLink href={templates.member} prominent>
                                        {copy.memberLink}
                                    </ExternalLink>
                                    <p className="text-sm text-stone-600 dark:text-stone-400">{copy.memberHint}</p>
                                </div>
                                <div className="space-y-1">
                                    <ExternalLink href={templates.ownerSharing} prominent>
                                        {copy.ownerLink}
                                    </ExternalLink>
                                    <p className="text-sm text-stone-600 dark:text-stone-400">{copy.ownerHint}</p>
                                </div>
                            </div>
                            <p className="text-sm text-stone-600 dark:text-stone-400">{copy.approvalHint}</p>
                        </>
                    )}
                </Step>
                <Step number={3} label={copy.stepLabel(3)} title={copy.connectStep}>
                    <label className="block text-sm font-semibold">
                        {copy.tokenLabel}
                        <input
                            ref={token}
                            name="token"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            required
                            aria-describedby={tokenHint}
                            className={cn(field, "font-mono", focusRing)}
                        />
                    </label>
                    <p id={tokenHint} className="text-sm text-stone-600 dark:text-stone-400">
                        {copy.tokenHint}
                    </p>
                    <Button type="submit" busy={busy}>
                        {copy.connect}
                    </Button>
                </Step>
            </ol>
        </form>
    );
}

function Step({
    number,
    label,
    title,
    children,
}: {
    readonly number: number;
    /** Read before the title by assistive technology, e.g. "Step 1: ". */
    readonly label: string;
    readonly title: string;
    readonly children: ReactNode;
}) {
    return (
        <li className="grid grid-cols-[2rem_1fr] gap-x-3">
            <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
            >
                {number}
            </span>
            <div className="space-y-3">
                <h3 className="pt-1 font-semibold">
                    <span className="sr-only">{label}</span>
                    {title}
                </h3>
                {children}
            </div>
        </li>
    );
}
