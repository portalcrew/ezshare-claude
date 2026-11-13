import { useStore } from "zustand";
import type { HistoryStart } from "../../shared/protocol.ts";
import { ElapsedTime } from "../components/elapsed-time.tsx";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import type { ChatOutcome, ChatStore } from "../view-models/chat-store.ts";
import { errorMessage } from "../view-models/copy.ts";

/** The member's personal Claude session. */
export function ChatView({
    store,
    repository,
    now,
}: {
    readonly store: ChatStore;
    readonly repository: string;
    readonly now: () => number;
}) {
    const phase = useStore(store, (state) => state.phase);
    const command = useStore(store, (state) => state.command);
    const problem = useStore(store, (state) => state.problem);
    const commandError = useStore(store, (state) => state.commandError);
    const replacingHistory = useStore(store, (state) => state.replacingHistory);
    const actions = store.getState();

    return (
        <Card title="Your Claude session">
            {problem !== null && (
                <Notice tone="warning" title="Status may be out of date">
                    {errorMessage(problem)}{" "}
                    <Button variant="quiet" onClick={actions.refresh}>
                        Refresh now
                    </Button>
                </Notice>
            )}
            {commandError !== null && <Notice tone="error">{errorMessage(commandError)}</Notice>}
            {(() => {
                switch (phase.kind) {
                    case "loading":
                        return (
                            <p aria-busy="true" className="text-sm">
                                Checking your session…
                            </p>
                        );
                    case "idle":
                        return (
                            <>
                                <Announcer
                                    message={
                                        phase.outcome === null || phase.outcome.kind === "failed"
                                            ? ""
                                            : outcomeText(phase.outcome)
                                    }
                                />
                                {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                <p className="text-sm">
                                    Start a private Claude session that uses the team account. A session lasts up to one
                                    hour. When it ends, your conversation and workspace are encrypted with a key that
                                    only this browser keeps, and the next session continues from them.
                                </p>
                                {replacingHistory && (
                                    <Notice tone="info">
                                        Your next session starts with an empty history and saves it in place of the one
                                        this browser cannot read.
                                    </Notice>
                                )}
                                <Button busy={command === "start"} onClick={actions.start}>
                                    Start a session
                                </Button>
                            </>
                        );
                    case "busy":
                        return (
                            <>
                                <Notice tone="info" title="You already have a session running">
                                    Only one session per member can run at a time. End it before starting another.
                                </Notice>
                                <ul className="space-y-3">
                                    {phase.runs.map((run) => (
                                        <li key={run.id} className="flex flex-wrap items-center gap-3">
                                            <ExternalLink
                                                href={`https://github.com/${repository}/actions/runs/${run.id}`}
                                            >
                                                {run.path.endsWith("login.yml") ? "Account sharing run" : "Session run"}{" "}
                                                {run.id}
                                            </ExternalLink>
                                            <Button
                                                variant="danger"
                                                busy={command === "cancel_run"}
                                                onClick={() => actions.cancelRun(run.id)}
                                            >
                                                End run {run.id}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        );
                    case "starting":
                    case "queued":
                    case "preparing":
                        return (
                            <>
                                <Announcer
                                    message={
                                        phase.kind === "preparing" ? "Preparing your session." : "Session requested."
                                    }
                                />
                                <ProgressSteps
                                    label="Session progress"
                                    steps={["Requested", "Waiting for a runner", "Preparing Claude", "Ready"]}
                                    current={phase.kind === "starting" ? 0 : phase.kind === "queued" ? 1 : 2}
                                />
                                {phase.kind !== "starting" && (
                                    <p className="text-sm text-stone-600 dark:text-stone-400">
                                        Waiting <ElapsedTime since={phase.session.startedAt} now={now} />. The first
                                        start usually takes two to four minutes. You can close this page; it picks up
                                        where you left off.
                                    </p>
                                )}
                                {phase.kind !== "starting" && (
                                    <Button variant="secondary" busy={command === "stop"} onClick={actions.stop}>
                                        Cancel
                                    </Button>
                                )}
                            </>
                        );
                    case "ready":
                        return (
                            <>
                                <Announcer message="Your session is ready." />
                                <Notice tone="success" title="Your session is ready">
                                    Claude is running with the team account in a workspace only you can reach.
                                </Notice>
                                <HistoryNotice
                                    start={phase.history}
                                    replacing={replacingHistory}
                                    busy={command === "replace_history"}
                                    onReplace={actions.replaceHistory}
                                />
                                <ExternalLink href={phase.url} prominent>
                                    Open chat
                                </ExternalLink>
                                <p className="text-sm text-stone-600 dark:text-stone-400">
                                    Anyone with this link can use your session until it ends, so do not share it. The
                                    session ends after one hour. End it here when you are done, so your history is
                                    saved.
                                </p>
                                <Button variant="danger" busy={command === "stop"} onClick={actions.stop}>
                                    End session
                                </Button>
                            </>
                        );
                    case "stopping":
                        return (
                            <>
                                <Announcer message="Ending your session." />
                                <p aria-busy="true" className="text-sm">
                                    Ending your session…
                                </p>
                                {!phase.forced && (
                                    <Button variant="quiet" busy={command === "force_stop"} onClick={actions.forceStop}>
                                        End immediately (skips cleanup)
                                    </Button>
                                )}
                            </>
                        );
                    default:
                        return phase satisfies never;
                }
            })()}
        </Card>
    );
}

function outcomeText(outcome: ChatOutcome): string {
    switch (outcome.kind) {
        case "stopped":
            return outcome.history === "archived"
                ? "Your last session ended. Its history is saved for your next session."
                : "Your last session ended. Its history was not saved.";
        case "expired":
            return "Your last session reached its time limit and ended.";
        case "failed":
            return errorMessage(outcome.code);
        default:
            return outcome satisfies never;
    }
}

function OutcomeNotice({ outcome }: { readonly outcome: ChatOutcome }) {
    return outcome.kind === "failed" ? (
        <Notice tone="error" title="Your last session ended with a problem">
            {outcomeText(outcome)}
        </Notice>
    ) : (
        <Notice tone="info">{outcomeText(outcome)}</Notice>
    );
}

function HistoryNotice({
    start,
    replacing,
    busy,
    onReplace,
}: {
    readonly start: HistoryStart;
    readonly replacing: boolean;
    readonly busy: boolean;
    readonly onReplace: () => void;
}) {
    switch (start) {
        case "restored":
            return <p className="text-sm">Your previous conversation and workspace are restored.</p>;
        case "new":
            return <p className="text-sm">This is your first saved session; its history is kept when it ends.</p>;
        case "off":
            return (
                <Notice tone="info">
                    History is off for this session, because this page was closed while it started.
                </Notice>
            );
        case "unreadable":
            return (
                <Notice tone="warning" title="Your saved history could not be opened">
                    It was saved from another browser, or this browser's site data was cleared. This session starts
                    empty and does not overwrite it.{" "}
                    {replacing ? (
                        "Your next session will replace it."
                    ) : (
                        <Button variant="quiet" busy={busy} onClick={onReplace}>
                            Replace it from the next session
                        </Button>
                    )}
                </Notice>
            );
        default:
            return start satisfies never;
    }
}
