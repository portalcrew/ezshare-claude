import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { Clock } from "../../shared/async.ts";
import { type HistoryStart, lifetime } from "../../shared/protocol.ts";
import { ElapsedTime, RemainingTime } from "../components/elapsed-time.tsx";
import { ProgressSteps } from "../components/progress-steps.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, StatusLine } from "../components/ui/card.tsx";
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

/** The member's Claude workspace: asleep, waking, awake or going to sleep, with one main action for each. */
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
        <Card title={chatCopy.title} status={<PhaseStatus phase={phase} clock={clock} />}>
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
                <p className="text-sm text-ink-3">{accountsCopy.using(sessionAccountLabel(phase.session.account))}</p>
            )}
            {(() => {
                switch (phase.kind) {
                    case "loading":
                        return (
                            <p aria-busy="true" className="text-sm text-ink-3">
                                {chatCopy.loading}
                            </p>
                        );
                    case "idle": {
                        const ready = accounts.kind === "ready" && accounts.items.length > 0;
                        return (
                            <>
                                {phase.outcome?.kind === "failed" ? (
                                    <OutcomeNotice outcome={phase.outcome} />
                                ) : (
                                    <div role="status">
                                        {phase.outcome !== null && <OutcomeNotice outcome={phase.outcome} />}
                                    </div>
                                )}
                                {phase.outcome?.kind !== "failed" && (
                                    <p className="text-sm text-ink-3">{chatCopy.intro}</p>
                                )}
                                {replacingHistory && <Notice tone="info">{chatCopy.replacingHistory}</Notice>}
                                {newMortyIdentity && client === "morty" && (
                                    <Notice tone="info">{chatCopy.newMortyIdentityPending}</Notice>
                                )}
                                <AccountsPicker
                                    catalog={accounts}
                                    selected={selectedAccount}
                                    disabled={command !== null}
                                    onSelect={actions.selectAccount}
                                    onRetry={actions.refresh}
                                    onShare={onShare}
                                />
                                {ready && (
                                    <>
                                        <Button
                                            className="min-h-12 w-full text-[15px]"
                                            busy={command === "start"}
                                            disabled={
                                                selectedAccount === null || (command !== null && command !== "start")
                                            }
                                            onClick={actions.start}
                                        >
                                            {chatCopy.start}
                                        </Button>
                                        {phase.outcome?.kind === "failed" &&
                                            phase.outcome.code === "morty_unavailable" &&
                                            client === "morty" &&
                                            !newMortyIdentity && (
                                                <Button
                                                    variant="secondary"
                                                    className="w-full"
                                                    disabled={command !== null || selectedAccount === null}
                                                    onClick={() => {
                                                        actions.setNewMortyIdentity(true);
                                                        actions.start();
                                                    }}
                                                >
                                                    {chatCopy.retryWithNewMorty}
                                                </Button>
                                            )}
                                        <ClientPicker
                                            client={client}
                                            disabled={command !== null}
                                            onSelect={actions.selectClient}
                                        />
                                    </>
                                )}
                            </>
                        );
                    }
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
                                <p className="text-[15px] font-medium">{chatCopy.wakingTitle}</p>
                                <ProgressSteps
                                    label={chatCopy.progress}
                                    steps={chatCopy.steps}
                                    current={phase.kind === "starting" ? 0 : phase.kind === "queued" ? 1 : 2}
                                />
                                {phase.kind !== "starting" && (
                                    <p className="text-sm text-ink-3">
                                        {chatCopy.waiting.beforeElapsed}
                                        <ElapsedTime since={phase.session.startedAt} clock={clock} />
                                        {chatCopy.waiting.afterElapsed}
                                    </p>
                                )}
                                <KeepOpen />
                                {phase.kind !== "starting" && (
                                    <Button
                                        variant="secondary"
                                        className="w-full"
                                        busy={command === "stop"}
                                        onClick={actions.stop}
                                    >
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
                                <p role="status" className="text-sm text-ink-3">
                                    {chatCopy.vscodeAuthorizationWaiting}
                                </p>
                                <Button variant="secondary" busy={command === "stop"} onClick={actions.stop}>
                                    {commonCopy.cancel}
                                </Button>
                            </>
                        );
                    case "ready": {
                        const saves = phase.history !== "unreadable" && phase.history !== "off";
                        return (
                            <>
                                <SessionReady
                                    phase={phase}
                                    client={client}
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
                                <div className="space-y-2 border-t border-black/[0.06] pt-4">
                                    <Button
                                        variant="secondary"
                                        busy={command === "stop"}
                                        disabled={command !== null && command !== "stop"}
                                        onClick={actions.stop}
                                    >
                                        {saves ? chatCopy.end : chatCopy.endWithoutSave}
                                    </Button>
                                    <p className="text-xs text-ink-3">
                                        {saves ? `${chatCopy.saveHint} ${chatCopy.idleHint}` : chatCopy.idleHint}
                                    </p>
                                </div>
                                <KeepOpen />
                            </>
                        );
                    }
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
                                        <summary className="min-h-11 cursor-pointer py-3 text-ink-3">
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

/** The dot and words above the card title. */
function PhaseStatus({ phase, clock }: { readonly phase: ChatPhase; readonly clock: Clock }) {
    switch (phase.kind) {
        case "loading":
        case "idle":
            return <StatusLine tone="idle">{chatCopy.state.asleep}</StatusLine>;
        case "busy":
            return <StatusLine tone="warn">{chatCopy.state.busy}</StatusLine>;
        case "starting":
        case "queued":
        case "preparing":
        case "authorizing":
            return <StatusLine tone="busy">{chatCopy.state.waking}</StatusLine>;
        case "ready":
            return (
                <StatusLine tone="ok">
                    {chatCopy.state.awake}
                    <span aria-hidden="true">·</span>
                    <RemainingTime
                        until={phase.session.startedAt + lifetime("chat")}
                        clock={clock}
                        label={chatCopy.estimatedTime}
                    />
                </StatusLine>
            );
        case "stopping":
            return <StatusLine tone="busy">{chatCopy.state.sleeping}</StatusLine>;
        default:
            return phase satisfies never;
    }
}

function KeepOpen() {
    return <p className="rounded-[16px] bg-fill px-4 py-3 text-xs leading-5 text-ink-2">{chatCopy.keepOpen}</p>;
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
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-ink-3">
            <label className="flex items-center gap-2">
                {chatCopy.access}
                <select
                    value={client}
                    disabled={disabled}
                    onChange={(event) => onSelect(event.currentTarget.value)}
                    className="min-h-9 rounded-full border-0 bg-fill px-3 text-xs font-medium text-ink-2"
                >
                    {clients.map((item) => (
                        <option key={item} value={item}>
                            {chatCopy.clients[item]}
                        </option>
                    ))}
                </select>
            </label>
            <span>{chatCopy.clientHint}</span>
        </div>
    );
}

function SessionReady({
    phase,
    client,
    busy,
    onSelect,
    children,
}: {
    readonly phase: Extract<ChatPhase, { readonly kind: "ready" }>;
    readonly client: SessionClient;
    readonly busy: boolean;
    readonly onSelect: (value: string) => void;
    readonly children: ReactNode;
}) {
    const desktop = phase.access === "vscode" && client === "vscode-desktop";
    return (
        <div className="space-y-4">
            <p role="status" className="text-[15px] font-medium">
                {chatCopy.readyTitle}
            </p>
            {children}
            <div className="[&>a]:min-h-12 [&>a]:w-full [&>a]:text-[15px]">
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
            <p className="text-sm text-ink-3">
                {phase.access === "morty" ? chatCopy.readyHint : desktop ? chatCopy.desktopHelp : chatCopy.webHelp}
            </p>
            {phase.access === "vscode" && (
                <details className="text-sm">
                    <summary className="min-h-11 cursor-pointer py-3 font-medium text-ink-3">
                        {chatCopy.changeClient}
                    </summary>
                    <div className="space-y-2 pb-2">
                        <ClientPicker
                            client={desktop ? "vscode-desktop" : "vscode"}
                            clients={["vscode", "vscode-desktop"]}
                            disabled={busy}
                            onSelect={onSelect}
                        />
                        <p className="text-ink-3">{chatCopy.switchClientHint}</p>
                    </div>
                </details>
            )}
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
            return <p className="text-sm text-ink-2">{chatCopy.history.restored}</p>;
        case "new":
            return <p className="text-sm text-ink-2">{chatCopy.history.new}</p>;
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
