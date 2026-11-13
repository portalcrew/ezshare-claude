import { useStore } from "zustand";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { SecretForm } from "../components/secret-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import { commonCopy, errorMessage, sharingCopy } from "../view-models/copy.ts";
import type { SharingOutcome, SharingStore } from "../view-models/sharing-store.ts";

/** Sharing the owner's Claude account with the repository. */
export function SharingView({
    store,
    branchProtected,
}: {
    readonly store: SharingStore;
    readonly branchProtected: boolean;
}) {
    const phase = useStore(store, (state) => state.phase);
    const command = useStore(store, (state) => state.command);
    const problem = useStore(store, (state) => state.problem);
    const commandError = useStore(store, (state) => state.commandError);
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
                                <p className="text-sm">{sharingCopy.intro}</p>
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
                                <Button busy={command === "start"} onClick={actions.start}>
                                    {sharingCopy.start}
                                </Button>
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
                    case "authorizing":
                        return (
                            <>
                                <Announcer message={sharingCopy.authorizingAnnouncement} />
                                <ol className="list-decimal space-y-3 pl-5 text-sm">
                                    <li>
                                        <ExternalLink href={phase.url}>{sharingCopy.authorize.link}</ExternalLink>
                                        {sharingCopy.authorize.afterLink}
                                    </li>
                                    <li>{sharingCopy.pasteCode}</li>
                                </ol>
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
            <p className="text-sm text-stone-600 dark:text-stone-400">
                {sharingCopy.stopSharing.beforeLink}
                <ExternalLink href={sharingCopy.stopSharing.url}>{sharingCopy.stopSharing.link}</ExternalLink>
                {sharingCopy.stopSharing.afterLink}
            </p>
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
