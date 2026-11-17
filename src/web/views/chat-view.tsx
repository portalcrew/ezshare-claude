import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { Clock } from "../../shared/async.ts";
import { type HistoryStart, lifetime } from "../../shared/protocol.ts";
import { ElapsedTime, RemainingTime } from "../components/elapsed-time.tsx";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import type { SessionClient } from "../services/vault.ts";
import type { ChatOutcome, ChatPhase, ChatStore } from "../view-models/chat-store.ts";
import {
    accountsCopy,
    blockingRunLabel,
    chatCopy,
    chatOutcomeText,
    commonCopy,
    errorMessage,
    sessionAccountLabel,
} from "../view-models/copy.ts";
import { AccountsPicker } from "./accounts-view.tsx";

/** The member's personal Claude session. */
export function ChatView({
    store,
    repository,
    clock,
    onShare,
}: {
    readonly onShare: () => void;
    readonly store: ChatStore;
    readonly repository: string;
    readonly clock: Clock;
}) {
    const accounts = useStore(store, (state) => state.accounts);
    const selectedAccount = useStore(store, (state) => state.selectedAccount);
    const phase = useStore(store, (state) => state.phase);
    const command = useStore(store, (state) => state.command);
    const problem = useStore(store, (state) => state.problem);
    const commandError = useStore(store, (state) => state.commandError);
    const client = useStore(store, (state) => state.client);
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
            {"session" in phase && (
                <p className="text-sm font-medium">{accountsCopy.using(sessionAccountLabel(phase.session.account))}</p>
            )}
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
                                {phase.outcome?.kind === "failed" ? (
                                    <OutcomeNotice outcome={phase.outcome} />
                                ) : (
                                    <div role="status">
                                        {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                    </div>
                                )}
                                <p className="text-sm">{chatCopy.intro}</p>
                                {replacingHistory && <Notice tone="info">{chatCopy.replacingHistory}</Notice>}
                                <AccountsPicker
                                    catalog={accounts}
                                    selected={selectedAccount}
                                    disabled={command !== null}
                                    onSelect={actions.selectAccount}
                                    onRetry={actions.refresh}
                                    onShare={onShare}
                                />
                                {accounts.kind === "ready" && accounts.items.length > 0 && (
                                    <>
                                        <ClientPicker
                                            client={client}
                                            disabled={command !== null}
                                            onSelect={actions.selectClient}
                                        />
                                        <p className="text-sm text-stone-600 dark:text-stone-400">
                                            {chatCopy.clientHint}
                                        </p>
                                        {client === "morty" && (
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
                                        <Button
                                            busy={command === "start"}
                                            disabled={
                                                selectedAccount === null || (command !== null && command !== "start")
                                            }
                                            onClick={actions.start}
                                        >
                                            {chatCopy.start}
                                        </Button>
                                    </>
                                )}
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
                                        <ElapsedTime since={phase.session.startedAt} clock={clock} />
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
                                <SessionReady
                                    phase={phase}
                                    client={client}
                                    clock={clock}
                                    busy={command !== null}
                                    onSelect={actions.selectClient}
                                >
                                    <HistoryNotice
                                        start={phase.history}
                                        replacing={replacingHistory}
                                        busy={command === "replace_history"}
                                        onReplace={actions.replaceHistory}
                                    />
                                </SessionReady>
                                <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 pt-4 dark:border-stone-800">
                                    <Button
                                        variant="secondary"
                                        busy={command === "stop"}
                                        disabled={command !== null && command !== "stop"}
                                        onClick={actions.stop}
                                    >
                                        {phase.history === "unreadable" || phase.history === "off"
                                            ? chatCopy.endWithoutSave
                                            : chatCopy.end}
                                    </Button>
                                    {phase.history !== "unreadable" && phase.history !== "off" && (
                                        <p className="max-w-xs text-xs text-stone-600 dark:text-stone-400">
                                            {chatCopy.saveHint}
                                        </p>
                                    )}
                                </div>
                            </>
                        );
                    case "stopping":
                        return (
                            <>
                                <p role="status" aria-busy="true" className="text-sm">
                                    {phase.mode === "force"
                                        ? chatCopy.stoppingForced
                                        : phase.mode === "save"
                                          ? chatCopy.saving
                                          : chatCopy.stopping}
                                </p>
                                {phase.mode !== "force" && (
                                    <details className="text-sm">
                                        <summary className="min-h-11 cursor-pointer py-3 text-stone-600 dark:text-stone-400">
                                            {chatCopy.savingHelp}
                                        </summary>
                                        <p className="mb-3">{chatCopy.forceStopHint}</p>
                                        <Button
                                            variant="danger"
                                            busy={command === "force_stop"}
                                            onClick={actions.forceStop}
                                        >
                                            {chatCopy.forceStop}
                                        </Button>
                                    </details>
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

function ClientPicker({
    client,
    disabled,
    onSelect,
    clients = ["morty", "vscode", "vscode-desktop"],
}: {
    readonly client: SessionClient;
    readonly disabled: boolean;
    readonly onSelect: (value: string) => void;
    readonly clients?: readonly SessionClient[];
}) {
    return (
        <label className="grid max-w-sm gap-2 text-sm font-medium">
            {chatCopy.access}
            <select
                value={client}
                disabled={disabled}
                onChange={(event) => onSelect(event.currentTarget.value)}
                className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100"
            >
                {clients.map((item) => (
                    <option key={item} value={item}>
                        {chatCopy.clients[item]}
                    </option>
                ))}
            </select>
        </label>
    );
}

function SessionReady({
    phase,
    client,
    clock,
    busy,
    onSelect,
    children,
}: {
    readonly phase: Extract<ChatPhase, { readonly kind: "ready" }>;
    readonly client: SessionClient;
    readonly clock: Clock;
    readonly busy: boolean;
    readonly onSelect: (value: string) => void;
    readonly children: ReactNode;
}) {
    const desktop = phase.access === "vscode" && client === "vscode-desktop";
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
                <p role="status" className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-300">
                    <span aria-hidden="true" className="size-2 rounded-full bg-emerald-600" />
                    {chatCopy.readyTitle}
                </p>
                <div className="text-xs text-stone-600 dark:text-stone-400">
                    <RemainingTime
                        until={phase.session.startedAt + lifetime("chat")}
                        clock={clock}
                        label={chatCopy.estimatedTime}
                    />
                </div>
            </div>
            {children}
            <div className="flex flex-wrap items-center gap-4">
                <ExternalLink
                    href={desktop ? phase.desktopUrl : phase.url}
                    destination={desktop ? "application" : "browser"}
                    prominent
                >
                    {phase.access === "morty"
                        ? chatCopy.open
                        : desktop
                          ? chatCopy.vscodeDesktopOpen
                          : chatCopy.vscodeOpen}
                </ExternalLink>
            </div>
            <p className="text-sm text-stone-600 dark:text-stone-400">
                {phase.access === "morty" ? chatCopy.readyHint : desktop ? chatCopy.desktopHelp : chatCopy.webHelp}
            </p>
            {phase.access === "vscode" && (
                <details className="text-sm">
                    <summary className="min-h-11 cursor-pointer py-3 font-medium text-stone-600 dark:text-stone-400">
                        {chatCopy.changeClient}
                    </summary>
                    <div className="space-y-2 pb-2">
                        <ClientPicker
                            client={desktop ? "vscode-desktop" : "vscode"}
                            clients={["vscode", "vscode-desktop"]}
                            disabled={busy}
                            onSelect={onSelect}
                        />
                        <p className="text-stone-600 dark:text-stone-400">{chatCopy.switchClientHint}</p>
                    </div>
                </details>
            )}
            <p className="text-xs text-stone-600 dark:text-stone-400">{chatCopy.idleHint}</p>
        </div>
    );
}

function OutcomeNotice({ outcome }: { readonly outcome: ChatOutcome }) {
    return outcome.kind === "failed" ? (
        <Notice tone="error" title={chatCopy.failedTitle}>
            {chatOutcomeText(outcome)}
        </Notice>
    ) : (
        <Notice tone={outcome.kind === "stopped" && outcome.history === "not_archived" ? "warning" : "info"}>
            {chatOutcomeText(outcome)}
        </Notice>
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
