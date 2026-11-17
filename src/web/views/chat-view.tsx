import { useStore } from "zustand";
import type { HistoryStart } from "../../shared/protocol.ts";
import { ElapsedTime } from "../components/elapsed-time.tsx";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import type { ChatOutcome, ChatStore } from "../view-models/chat-store.ts";
import { blockingRunLabel, chatCopy, chatOutcomeText, commonCopy, errorMessage } from "../view-models/copy.ts";

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
    const access = useStore(store, (state) => state.access);
    const newMortyIdentity = useStore(store, (state) => state.newMortyIdentity);
    const replacingHistory = useStore(store, (state) => state.replacingHistory);
    const actions = store.getState();

    return (
        <Card title={chatCopy.title}>
            {problem !== null && (
                <Notice tone="warning" title={commonCopy.staleStatusTitle}>
                    {errorMessage(problem)}{" "}
                    <Button variant="quiet" onClick={actions.refresh}>
                        {chatCopy.refresh}
                    </Button>
                </Notice>
            )}
            {commandError !== null && <Notice tone="error">{errorMessage(commandError)}</Notice>}
            {(() => {
                switch (phase.kind) {
                    case "loading":
                        return (
                            <p aria-busy="true" className="text-sm">
                                {chatCopy.loading}
                            </p>
                        );
                    case "idle":
                        return (
                            <>
                                <Announcer
                                    message={
                                        phase.outcome === null || phase.outcome.kind === "failed"
                                            ? ""
                                            : chatOutcomeText(phase.outcome)
                                    }
                                />
                                {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                <p className="text-sm">{chatCopy.intro}</p>
                                {replacingHistory && <Notice tone="info">{chatCopy.replacingHistory}</Notice>}
                                <label className="grid gap-2 text-sm font-medium">
                                    {chatCopy.access}
                                    <select
                                        value={access}
                                        disabled={command !== null}
                                        onChange={(event) => actions.setAccess(event.currentTarget.value)}
                                        aria-describedby="session-access-hint"
                                        className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100"
                                    >
                                        <option value="morty">{chatCopy.accessMorty}</option>
                                        <option value="vscode">{chatCopy.accessVscode}</option>
                                    </select>
                                </label>
                                <p id="session-access-hint" className="text-sm text-stone-600 dark:text-stone-400">
                                    {chatCopy.accessHint}
                                </p>
                                {access === "morty" && (
                                    <div className="space-y-1">
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={newMortyIdentity}
                                                disabled={command !== null}
                                                aria-describedby="new-morty-identity-hint"
                                                onChange={(event) =>
                                                    actions.setNewMortyIdentity(event.currentTarget.checked)
                                                }
                                                className="size-4 accent-emerald-700"
                                            />
                                            {chatCopy.newMortyIdentity}
                                        </label>
                                        <p
                                            id="new-morty-identity-hint"
                                            className="text-sm text-stone-600 dark:text-stone-400"
                                        >
                                            {chatCopy.newMortyIdentityHint}
                                        </p>
                                    </div>
                                )}
                                <Button busy={command === "start"} onClick={actions.start}>
                                    {chatCopy.start}
                                </Button>
                            </>
                        );
                    case "busy":
                        return (
                            <>
                                <Notice tone="info" title={chatCopy.busyTitle}>
                                    {chatCopy.busyBody}
                                </Notice>
                                <ul className="space-y-3">
                                    {phase.runs.map((run) => (
                                        <li key={run.id} className="flex flex-wrap items-center gap-3">
                                            <ExternalLink
                                                href={`https://github.com/${repository}/actions/runs/${run.id}`}
                                            >
                                                {blockingRunLabel(run)}
                                            </ExternalLink>
                                            <Button
                                                variant="danger"
                                                busy={command === "cancel_run"}
                                                onClick={() => actions.cancelRun(run.id)}
                                            >
                                                {chatCopy.endRun(run.id)}
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
                                    message={phase.kind === "preparing" ? chatCopy.preparing : chatCopy.requested}
                                />
                                <ProgressSteps
                                    label={chatCopy.progress}
                                    steps={chatCopy.steps}
                                    current={phase.kind === "starting" ? 0 : phase.kind === "queued" ? 1 : 2}
                                />
                                {phase.kind !== "starting" && (
                                    <p className="text-sm text-stone-600 dark:text-stone-400">
                                        {chatCopy.waiting.beforeElapsed}
                                        <ElapsedTime since={phase.session.startedAt} now={now} />
                                        {chatCopy.waiting.afterElapsed}
                                    </p>
                                )}
                                {phase.kind !== "starting" && (
                                    <Button variant="secondary" busy={command === "stop"} onClick={actions.stop}>
                                        {commonCopy.cancel}
                                    </Button>
                                )}
                            </>
                        );
                    case "authorizing":
                        return (
                            <>
                                <Notice tone="info" title={chatCopy.vscodeAuthorizationTitle}>
                                    {chatCopy.vscodeAuthorizationHint}
                                </Notice>
                                <code className="block select-all text-2xl font-semibold tracking-widest">
                                    {phase.code}
                                </code>
                                <ExternalLink href="https://github.com/login/device" prominent>
                                    {chatCopy.vscodeAuthorize}
                                </ExternalLink>
                                <p role="status" className="text-sm">
                                    {chatCopy.vscodeAuthorizationWaiting}
                                </p>
                                <Button variant="secondary" busy={command === "stop"} onClick={actions.stop}>
                                    {commonCopy.cancel}
                                </Button>
                            </>
                        );
                    case "ready":
                        return (
                            <>
                                <Announcer message={chatCopy.readyAnnouncement} />
                                <Notice tone="success" title={chatCopy.readyTitle}>
                                    {phase.access === "vscode" ? chatCopy.vscodeReadyBody : chatCopy.readyBody}
                                </Notice>
                                <HistoryNotice
                                    start={phase.history}
                                    replacing={replacingHistory}
                                    busy={command === "replace_history"}
                                    onReplace={actions.replaceHistory}
                                />
                                {phase.access === "vscode" && (
                                    <ExternalLink href={phase.desktopUrl} destination="application" prominent>
                                        {chatCopy.vscodeDesktopOpen}
                                    </ExternalLink>
                                )}
                                <ExternalLink href={phase.url} prominent={phase.access === "morty"}>
                                    {phase.access === "vscode" ? chatCopy.vscodeOpen : chatCopy.open}
                                </ExternalLink>
                                <p className="text-sm text-stone-600 dark:text-stone-400">
                                    {phase.access === "vscode" ? chatCopy.vscodeReadyHint : chatCopy.readyHint}
                                </p>
                                <Button variant="danger" busy={command === "stop"} onClick={actions.stop}>
                                    {chatCopy.end}
                                </Button>
                            </>
                        );
                    case "stopping":
                        return (
                            <>
                                <Announcer message={chatCopy.stoppingAnnouncement} />
                                <p aria-busy="true" className="text-sm">
                                    {chatCopy.stopping}
                                </p>
                                {!phase.forced && (
                                    <Button variant="quiet" busy={command === "force_stop"} onClick={actions.forceStop}>
                                        {chatCopy.forceStop}
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

function OutcomeNotice({ outcome }: { readonly outcome: ChatOutcome }) {
    return outcome.kind === "failed" ? (
        <Notice tone="error" title={chatCopy.failedTitle}>
            {chatOutcomeText(outcome)}
        </Notice>
    ) : (
        <Notice tone="info">{chatOutcomeText(outcome)}</Notice>
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
            return <p className="text-sm">{chatCopy.history.restored}</p>;
        case "new":
            return <p className="text-sm">{chatCopy.history.new}</p>;
        case "off":
            return <Notice tone="info">{chatCopy.history.off}</Notice>;
        case "unreadable":
            return (
                <Notice tone="warning" title={chatCopy.history.unreadableTitle}>
                    {chatCopy.history.unreadable}{" "}
                    {replacing ? (
                        chatCopy.history.willReplace
                    ) : (
                        <Button variant="quiet" busy={busy} onClick={onReplace}>
                            {chatCopy.history.replace}
                        </Button>
                    )}
                </Notice>
            );
        default:
            return start satisfies never;
    }
}
