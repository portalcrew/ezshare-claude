import { useStore } from "zustand";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { SecretForm } from "../components/secret-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import { errorMessage } from "../view-models/copy.ts";
import type { SharingOutcome, SharingStore } from "../view-models/sharing-store.ts";

const STEPS = ["Start", "Authorize on claude.ai", "Store for the team"];

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
        <Card title="Share your Claude account">
            {problem !== null && (
                <Notice tone="warning" title="Status may be out of date">
                    {errorMessage(problem)}
                </Notice>
            )}
            {commandError !== null && <Notice tone="error">{errorMessage(commandError)}</Notice>}
            {inProgress && (
                <ProgressSteps
                    label="Sharing progress"
                    steps={STEPS}
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
                                Checking for an authorization in progress…
                            </p>
                        );
                    case "intro":
                        return (
                            <>
                                {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                <p className="text-sm">
                                    Give every member of this repository a Claude session that uses your Claude account.
                                    You authorize once on claude.ai; the resulting token is stored as an encrypted
                                    repository secret and never kept in this browser.
                                </p>
                                <Notice tone="warning" title="Before you share">
                                    <ul className="list-disc space-y-1 pl-5">
                                        <li>
                                            Every member with write access can read the token from inside their own
                                            session and keep using it elsewhere. Share only with people you would give
                                            your account to.
                                        </li>
                                        <li>The token stays valid for one year unless you revoke it on claude.ai.</li>
                                        <li>Sharing replaces any account already shared with this repository.</li>
                                        <li>Check that your Claude plan's terms allow use by your team.</li>
                                    </ul>
                                </Notice>
                                {!branchProtected && (
                                    <Notice tone="warning" title="The default branch is not protected">
                                        Anyone with write access can change the code that receives your token. Protect
                                        the default branch and require reviews before sharing.
                                    </Notice>
                                )}
                                <Button busy={command === "start"} onClick={actions.start}>
                                    I understand, start authorization
                                </Button>
                            </>
                        );
                    case "starting":
                    case "waiting":
                        return (
                            <>
                                <Announcer message="Waiting for the authorization link." />
                                <p aria-busy="true" className="text-sm">
                                    Starting Claude's login. The authorization link appears here in about a minute.
                                </p>
                                {phase.kind === "waiting" && (
                                    <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                        Cancel
                                    </Button>
                                )}
                            </>
                        );
                    case "authorizing":
                        return (
                            <>
                                <Announcer message="The authorization link is ready." />
                                <ol className="list-decimal space-y-3 pl-5 text-sm">
                                    <li>
                                        <ExternalLink href={phase.url}>Open the Claude authorization page</ExternalLink>{" "}
                                        and sign in with the account you want to share.
                                    </li>
                                    <li>Copy the code Claude shows and paste it below.</li>
                                </ol>
                                <SecretForm
                                    label="Authorization code"
                                    hint="The code is encrypted for this login run before it leaves your browser."
                                    action="Submit code"
                                    busy={command === "submit_code"}
                                    onSubmit={actions.submitCode}
                                />
                                <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                    Cancel
                                </Button>
                            </>
                        );
                    case "completing":
                    case "publishing":
                        return (
                            <>
                                <Announcer message="Completing the authorization." />
                                <p aria-busy="true" className="text-sm">
                                    {phase.kind === "completing"
                                        ? "Claude is completing the authorization…"
                                        : "Storing the account for the team…"}
                                </p>
                                {phase.kind === "completing" && (
                                    <Button variant="secondary" busy={command === "cancel"} onClick={actions.cancel}>
                                        Cancel
                                    </Button>
                                )}
                            </>
                        );
                    default:
                        return phase satisfies never;
                }
            })()}
            <p className="text-sm text-stone-600 dark:text-stone-400">
                To stop sharing, revoke the token in{" "}
                <ExternalLink href="https://claude.ai/settings">your Claude account settings</ExternalLink> and delete
                the repository secret.
            </p>
        </Card>
    );
}

function OutcomeNotice({ outcome }: { readonly outcome: SharingOutcome }) {
    switch (outcome.kind) {
        case "shared":
            return (
                <>
                    <Announcer message="Your Claude account is shared with the team." />
                    <Notice tone="success" title="Shared with the team">
                        Members can now start sessions with your account.
                    </Notice>
                </>
            );
        case "cancelled":
            return <Notice tone="info">Authorization cancelled. Nothing was shared.</Notice>;
        case "failed":
            return (
                <Notice tone="error" title="Sharing did not complete">
                    {errorMessage(outcome.code)}
                </Notice>
            );
        default:
            return outcome satisfies never;
    }
}
