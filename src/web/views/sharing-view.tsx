import { useStore } from "zustand";
import { CopyField } from "../components/copy-field.tsx";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { SecretForm } from "../components/secret-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import {
    accountsCopy,
    commonCopy,
    errorMessage,
    sessionAccountLabel,
    sharedAccountLabel,
    sharingCopy,
} from "../view-models/copy.ts";
import type { SharingOutcome, SharingStore } from "../view-models/sharing-store.ts";
import { AccountsManager } from "./accounts-view.tsx";

/** Sharing the owner's Claude account with the repository. */
export function SharingView({
    store,
    branchProtected,
}: {
    readonly store: SharingStore;
    readonly branchProtected: boolean;
}) {
    const editor = useStore(store, (state) => state.editor);
    const accounts = useStore(store, (state) => state.accounts);
    const phase = useStore(store, (state) => state.phase);
    const command = useStore(store, (state) => state.command);
    const problem = useStore(store, (state) => state.problem);
    const commandError = useStore(store, (state) => state.commandError);
    const method = useStore(store, (state) => state.method);
    const actions = store.getState();
    const inProgress = phase.kind !== "loading" && phase.kind !== "intro";

    return (
        <Card title={sharingCopy.title}>
            {problem !== null && (
                <Notice tone="warning" title={commonCopy.staleStatusTitle}>
                    {errorMessage(problem)}
                </Notice>
            )}
            {commandError !== null && <Notice tone="error">{errorMessage(commandError)}</Notice>}
            {"session" in phase && (
                <p className="text-sm font-medium">{accountsCopy.using(sessionAccountLabel(phase.session.account))}</p>
            )}
            {inProgress && (
                <ProgressSteps
                    label={sharingCopy.progress}
                    steps={sharingCopy.steps}
                    current={
                        phase.kind === "authorizing"
                            ? 1
                            : phase.kind === "completing" || phase.kind === "publishing"
                              ? 2
                              : 0
                    }
                />
            )}
            {(() => {
                switch (phase.kind) {
                    case "loading":
                        return (
                            <p aria-busy="true" className="text-sm">
                                {sharingCopy.loading}
                            </p>
                        );
                    case "intro":
                        return (
                            <>
                                {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                <AccountsManager
                                    catalog={accounts}
                                    editor={editor}
                                    busy={command !== null}
                                    onAdd={actions.addAccount}
                                    onEdit={actions.editAccount}
                                    onRemove={actions.removeAccount}
                                    onCancel={actions.closeEditor}
                                    onRetry={actions.refresh}
                                />
                                {(editor.kind === "add" || editor.kind === "replace") && (
                                    <section
                                        aria-label={accountsCopy.authorizeTitle}
                                        className="space-y-4 border-t border-stone-200 pt-5 dark:border-stone-700"
                                    >
                                        {editor.kind === "add" ? (
                                            <div className="grid gap-2 text-sm font-medium">
                                                <label htmlFor="shared-account-name">{accountsCopy.name}</label>
                                                <input
                                                    id="shared-account-name"
                                                    value={editor.name}
                                                    disabled={command !== null}
                                                    onChange={(event) =>
                                                        actions.setAccountName(event.currentTarget.value)
                                                    }
                                                    maxLength={36}
                                                    autoComplete="off"
                                                    aria-describedby="account-name-hint"
                                                    className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100"
                                                />
                                                <span
                                                    id="account-name-hint"
                                                    className="text-sm font-normal text-stone-600 dark:text-stone-400"
                                                >
                                                    {accountsCopy.nameHint}
                                                </span>
                                            </div>
                                        ) : (
                                            <p className="text-sm">
                                                {accountsCopy.replaceHint(sharedAccountLabel(editor.account))}
                                            </p>
                                        )}
                                        <p className="text-sm">{sharingCopy.intro}</p>
                                        <p className="text-sm text-stone-600 dark:text-stone-400">
                                            {accountsCopy.writeAccess}
                                        </p>
                                        <Notice tone="warning" title={sharingCopy.risksTitle}>
                                            <ul className="list-disc space-y-1 pl-5">
                                                {sharingCopy.risks.map((risk) => (
                                                    <li key={risk}>{risk}</li>
                                                ))}
                                            </ul>
                                        </Notice>
                                        {!branchProtected && (
                                            <Notice tone="warning" title={sharingCopy.unprotectedTitle}>
                                                {sharingCopy.unprotectedBody}
                                            </Notice>
                                        )}
                                        <label className="grid gap-2 text-sm font-medium">
                                            {sharingCopy.method}
                                            <select
                                                value={method}
                                                disabled={command !== null}
                                                onChange={(event) => actions.selectMethod(event.currentTarget.value)}
                                                className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100"
                                            >
                                                <option value="browser">{sharingCopy.browserMethod}</option>
                                                <option value="vscode">{sharingCopy.runnerMethod}</option>
                                            </select>
                                        </label>
                                        {method === "vscode" && (
                                            <p className="text-sm text-stone-600 dark:text-stone-400">
                                                {sharingCopy.runnerMethodHint}
                                            </p>
                                        )}
                                        <Button busy={command === "start"} onClick={actions.start}>
                                            {sharingCopy.start}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            disabled={command !== null}
                                            onClick={actions.closeEditor}
                                        >
                                            {accountsCopy.back}
                                        </Button>
                                    </section>
                                )}
                            </>
                        );
                    case "starting":
                    case "waiting":
                        return (
                            <>
                                <Announcer message={sharingCopy.waitingAnnouncement} />
                                <p aria-busy="true" className="text-sm">
                                    {sharingCopy.waiting}
                                </p>
                                {phase.kind === "waiting" && (
                                    <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                        {commonCopy.cancel}
                                    </Button>
                                )}
                            </>
                        );
                    case "connecting_vscode":
                        return (
                            <>
                                <Notice tone="info" title={sharingCopy.vscodeConnectTitle}>
                                    {sharingCopy.vscodeConnectHint}
                                </Notice>
                                <code className="block select-all text-2xl font-semibold tracking-widest">
                                    {phase.code}
                                </code>
                                <ExternalLink href="https://github.com/login/device" prominent>
                                    {sharingCopy.vscodeConnect}
                                </ExternalLink>
                                <p role="status" className="text-sm">
                                    {sharingCopy.vscodeWaiting}
                                </p>
                                <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                    {commonCopy.cancel}
                                </Button>
                            </>
                        );
                    case "authorizing":
                        return (
                            <>
                                <Announcer message={sharingCopy.authorizingAnnouncement} />
                                {phase.entry.kind === "browser" ? (
                                    <ol className="list-decimal space-y-3 pl-5 text-sm">
                                        <li>
                                            <ExternalLink href={phase.entry.url}>
                                                {sharingCopy.authorize.link}
                                            </ExternalLink>
                                            {sharingCopy.authorize.afterLink}
                                        </li>
                                        <li>{sharingCopy.pasteCode}</li>
                                    </ol>
                                ) : (
                                    <div className="space-y-4">
                                        <ExternalLink href={phase.entry.desktopUrl} destination="application" prominent>
                                            {sharingCopy.vscodeOpen}
                                        </ExternalLink>
                                        <p className="text-sm">{sharingCopy.runnerBrowserHint}</p>
                                        <CopyField
                                            key={phase.entry.url}
                                            value={phase.entry.url}
                                            label={sharingCopy.authorizationLink}
                                            action={sharingCopy.copyAuthorization}
                                            copied={sharingCopy.authorizationCopied}
                                            manual={sharingCopy.authorizationManualCopy}
                                        />
                                        <p className="text-sm">{sharingCopy.runnerReturnCode}</p>
                                    </div>
                                )}
                                <SecretForm
                                    label={sharingCopy.codeLabel}
                                    hint={sharingCopy.codeHint}
                                    action={sharingCopy.submitCode}
                                    busy={command === "submit_code"}
                                    onSubmit={actions.submitCode}
                                />
                                <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                    {commonCopy.cancel}
                                </Button>
                            </>
                        );
                    case "completing":
                    case "publishing":
                        return (
                            <>
                                <Announcer message={sharingCopy.completingAnnouncement} />
                                <p aria-busy="true" className="text-sm">
                                    {phase.kind === "completing" ? sharingCopy.completing : sharingCopy.publishing}
                                </p>
                                {phase.kind === "completing" && (
                                    <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                        {commonCopy.cancel}
                                    </Button>
                                )}
                            </>
                        );
                    default:
                        return phase satisfies never;
                }
            })()}
            {phase.kind === "intro" && (
                <p className="text-sm text-stone-600 dark:text-stone-400">
                    {sharingCopy.stopSharing.beforeLink}
                    <ExternalLink href={sharingCopy.stopSharing.url}>{sharingCopy.stopSharing.link}</ExternalLink>
                    {sharingCopy.stopSharing.afterLink}
                </p>
            )}
        </Card>
    );
}

function OutcomeNotice({ outcome }: { readonly outcome: SharingOutcome }) {
    switch (outcome.kind) {
        case "shared":
            return (
                <>
                    <Announcer message={sharingCopy.sharedAnnouncement} />
                    <Notice tone="success" title={sharingCopy.sharedTitle}>
                        {sharingCopy.sharedBody}
                    </Notice>
                </>
            );
        case "cancelled":
            return <Notice tone="info">{sharingCopy.cancelled}</Notice>;
        case "failed":
            return (
                <Notice tone="error" title={sharingCopy.failedTitle}>
                    {errorMessage(outcome.code)}
                </Notice>
            );
        default:
            return outcome satisfies never;
    }
}
