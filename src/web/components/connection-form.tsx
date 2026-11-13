import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type { TokenTemplates } from "../view-models/copy.ts";
import { Button, focusRing } from "./ui/button.tsx";
import { ExternalLink } from "./ui/external-link.tsx";
import { cn } from "./utils/cn.ts";

const field =
    "mt-1 block min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm dark:border-stone-600 dark:bg-stone-950";

/** The three connection steps. The repository field is local state so the token links follow it as typed. */
export function ConnectionForm({
    initialRepository,
    templatesFor,
    busy,
    onConnect,
}: {
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
                <Step number={1} title="Confirm the team repository">
                    <label className="block text-sm font-semibold">
                        Repository
                        <input
                            name="repository"
                            value={repository}
                            onChange={(event) => setRepository(event.currentTarget.value)}
                            placeholder="owner/name"
                            autoComplete="off"
                            spellCheck={false}
                            required
                            className={cn(field, focusRing)}
                        />
                    </label>
                </Step>
                <Step number={2} title="Create a fine-grained GitHub token">
                    {templates === null ? (
                        <p className="text-sm">Enter the repository as owner/name to get a prefilled token link.</p>
                    ) : (
                        <>
                            <p className="text-sm">
                                The link opens GitHub with <strong>{templates.owner}</strong> as the resource owner and
                                Actions and Issues set to read and write. Under Repository access choose{" "}
                                <strong>Only select repositories</strong> and pick <strong>{templates.name}</strong>.
                            </p>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                <ExternalLink href={templates.member} prominent>
                                    Create a token
                                </ExternalLink>
                                <ExternalLink href={templates.ownerSharing}>
                                    Create a token that can also share an account
                                </ExternalLink>
                            </div>
                            <p className="text-sm text-stone-600 dark:text-stone-400">
                                Sharing your Claude account additionally needs Secrets read and write. Members who only
                                use the team account do not need it. Organizations may require an administrator to
                                approve new tokens.
                            </p>
                        </>
                    )}
                </Step>
                <Step number={3} title="Paste the token and connect">
                    <label className="block text-sm font-semibold">
                        GitHub token
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
                        The token is stored encrypted in this browser so you stay connected after a reload. Use
                        Disconnect to remove it.
                    </p>
                    <Button type="submit" busy={busy}>
                        Connect
                    </Button>
                </Step>
            </ol>
        </form>
    );
}

function Step({
    number,
    title,
    children,
}: {
    readonly number: number;
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
                    <span className="sr-only">Step {number}: </span>
                    {title}
                </h3>
                {children}
            </div>
        </li>
    );
}
