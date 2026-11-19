import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type { ConnectionFormCopy, TokenTemplates } from "../view-models/copy.ts";
import { Button, focusRing } from "./ui/button.tsx";
import { ExternalLink } from "./ui/external-link.tsx";
import { cn } from "./utils/cn.ts";

const field = "mt-1 block min-h-11 w-full rounded-[14px] border border-hairline bg-white px-3 text-sm";

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
                    <label className="block text-sm font-medium">
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
                                    <p className="text-sm text-ink-3">{copy.memberHint}</p>
                                </div>
                                <div className="space-y-1">
                                    <ExternalLink href={templates.ownerSharing}>{copy.ownerLink}</ExternalLink>
                                    <p className="text-sm text-ink-3">{copy.ownerHint}</p>
                                </div>
                            </div>
                            <p className="text-sm text-ink-3">{copy.approvalHint}</p>
                        </>
                    )}
                </Step>
                <Step number={3} label={copy.stepLabel(3)} title={copy.connectStep}>
                    <label className="block text-sm font-medium">
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
                    <p id={tokenHint} className="text-sm text-ink-3">
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

/** Keep the alternate method visible without showing the full token setup until it is selected. */
export function ConnectionChoices({
    repository,
    authorize,
    manual,
    back,
    hint,
    onAuthorize,
    children,
}: {
    readonly repository: string;
    readonly authorize: string;
    readonly manual: string;
    readonly back: string;
    readonly hint: string;
    readonly onAuthorize: () => void;
    readonly children: ReactNode;
}) {
    const [usingToken, setUsingToken] = useState(false);
    return usingToken ? (
        <div className="space-y-4">
            <Button variant="quiet" onClick={() => setUsingToken(false)}>
                {back}
            </Button>
            {children}
        </div>
    ) : (
        <div className="space-y-4">
            <Button onClick={onAuthorize} className="min-h-12 w-full text-[15px]">
                {authorize}
            </Button>
            <p className="text-center text-sm text-ink-3">{hint}</p>
            <div className="text-center">
                <Button variant="quiet" onClick={() => setUsingToken(true)}>
                    {manual}
                </Button>
            </div>
            <p className="text-center text-xs text-ink-3">{repository}</p>
        </div>
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
                className="flex size-8 items-center justify-center rounded-full bg-fill text-sm font-semibold text-ink-2"
            >
                {number}
            </span>
            <div className="space-y-3">
                <h3 className="pt-1 font-medium">
                    <span className="sr-only">{label}</span>
                    {title}
                </h3>
                {children}
            </div>
        </li>
    );
}
