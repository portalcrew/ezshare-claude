import { useStore } from "zustand";
import { isAccessDenied } from "../../shared/errors.ts";
import { ConnectionForm } from "../components/connection-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import type { ApplicationStore, Page, Workspace } from "../view-models/application-store.ts";
import {
    commonCopy,
    connectCopy,
    connectionFormCopy,
    errorMessage,
    launcherCopy,
    tokenAccessCopy,
    tokenTemplates,
    workspaceCopy,
} from "../view-models/copy.ts";
import { ChatView } from "./chat-view.tsx";
import { SharingView } from "./sharing-view.tsx";

const PAGES: readonly Page[] = ["use", "share"];

export function RootView({
    store,
    now,
    defaultRepository,
}: {
    readonly store: ApplicationStore;
    readonly now: () => number;
    readonly defaultRepository: string;
}) {
    const phase = useStore(store, (state) => state.phase);
    const page = useStore(store, (state) => state.page);
    const actions = store.getState();
    return (
        <div className="mx-auto max-w-2xl space-y-8 px-5 py-10 sm:py-16">
            <header className="space-y-3">
                <p className="text-xs font-bold tracking-[0.16em] text-emerald-800 uppercase dark:text-emerald-300">
                    {launcherCopy.product}
                </p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{launcherCopy.headline}</h1>
                <p className="text-stone-600 dark:text-stone-400">{launcherCopy.tagline}</p>
            </header>
            {phase.kind === "connected" ? (
                <Connected workspace={phase.workspace} page={page} store={store} now={now} />
            ) : (
                <section aria-label={connectCopy.title} className="space-y-5">
                    <h2 className="text-xl font-semibold">{connectCopy.title}</h2>
                    {(phase.kind === "restoring" || phase.kind === "disconnecting") && (
                        <p aria-busy="true" className="text-sm">
                            {phase.kind === "restoring" ? connectCopy.restoring : connectCopy.disconnecting}
                        </p>
                    )}
                    {phase.kind === "disconnected" && phase.error !== null && (
                        <Notice tone="error" title={connectCopy.failedTitle}>
                            {errorMessage(phase.error)}
                        </Notice>
                    )}
                    {(phase.kind === "disconnected" || phase.kind === "connecting") && (
                        <ConnectionForm
                            copy={connectionFormCopy}
                            initialRepository={defaultRepository}
                            templatesFor={tokenTemplates}
                            busy={phase.kind === "connecting"}
                            onConnect={actions.connect}
                        />
                    )}
                </section>
            )}
        </div>
    );
}

function Connected({
    workspace,
    page,
    store,
    now,
}: {
    readonly workspace: Workspace;
    readonly page: Page;
    readonly store: ApplicationStore;
    readonly now: () => number;
}) {
    const actions = store.getState();
    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                    {workspaceCopy.identity.beforeLogin}
                    <strong>{workspace.user.login}</strong>
                    {workspaceCopy.identity.beforeRepository}
                    <strong>{workspace.repository.name}</strong>
                </p>
                <Button variant="quiet" onClick={actions.disconnect}>
                    {workspaceCopy.disconnect}
                </Button>
            </div>
            <p className="text-sm text-stone-600 dark:text-stone-400">{workspaceCopy.identityHint}</p>
            <TokenAccessNotice workspace={workspace} onReplace={actions.disconnect} />
            {!workspace.repository.isPrivate && (
                <Notice tone="info" title={workspaceCopy.publicTitle}>
                    {workspaceCopy.publicBody}
                </Notice>
            )}
            <nav
                aria-label={workspaceCopy.sections}
                className="flex gap-2 border-b border-stone-200 dark:border-stone-800"
            >
                {PAGES.map((item) => (
                    <button
                        key={item}
                        type="button"
                        aria-current={page === item ? "page" : undefined}
                        onClick={() => actions.showPage(item)}
                        className="-mb-px min-h-11 border-b-2 border-transparent px-3 text-sm font-semibold text-stone-600 outline-none hover:text-stone-900 focus-visible:ring-[3px] focus-visible:ring-emerald-600/60 aria-[current=page]:border-emerald-700 aria-[current=page]:text-emerald-900 dark:text-stone-300 dark:hover:text-white dark:aria-[current=page]:border-emerald-400 dark:aria-[current=page]:text-emerald-200"
                    >
                        {workspaceCopy.pages[item]}
                    </button>
                ))}
            </nav>
            <div hidden={page !== "use"}>
                <ChatView store={workspace.chat} repository={workspace.repository.name} now={now} />
            </div>
            <div hidden={page !== "share"}>
                <SharingView store={workspace.sharing} branchProtected={workspace.branchProtected} />
            </div>
        </>
    );
}

function TokenAccessNotice({
    workspace,
    onReplace,
}: {
    readonly workspace: Workspace;
    readonly onReplace: () => void;
}) {
    const chatDenied = useStore(workspace.chat, (state) =>
        isAccessDenied(state.commandError) ? state.commandError : isAccessDenied(state.problem) ? state.problem : null,
    );
    const sharingDenied = useStore(workspace.sharing, (state) =>
        isAccessDenied(state.commandError) ? state.commandError : isAccessDenied(state.problem) ? state.problem : null,
    );
    const templates = tokenTemplates(workspace.repository.name);
    if ((!chatDenied && !sharingDenied) || templates === null) {
        return null;
    }
    return (
        <section aria-label={tokenAccessCopy.title}>
            <Announcer message={tokenAccessCopy.announcement} />
            <Notice tone="warning" title={tokenAccessCopy.title}>
                <div className="space-y-3">
                    {chatDenied !== null && <p>{errorMessage(chatDenied)}</p>}
                    {sharingDenied !== null && sharingDenied !== chatDenied && <p>{errorMessage(sharingDenied)}</p>}
                    <p>
                        {tokenAccessCopy.denied.beforeRepository}
                        <strong>{workspace.repository.name}</strong>
                        {tokenAccessCopy.denied.afterRepository}
                    </p>
                    <p>
                        {tokenAccessCopy.instructions.beforeOwner}
                        <strong>{templates.owner}</strong>
                        {tokenAccessCopy.instructions.beforeRepository}
                        <strong> {workspace.repository.name}</strong>
                        {tokenAccessCopy.instructions.afterRepository}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <ExternalLink href={templates.member}>{commonCopy.memberTokenLink}</ExternalLink>
                        <ExternalLink href={templates.ownerSharing}>{commonCopy.ownerTokenLink}</ExternalLink>
                        <Button variant="secondary" onClick={onReplace}>
                            {tokenAccessCopy.replace}
                        </Button>
                    </div>
                    <p>{tokenAccessCopy.replaceHint}</p>
                </div>
            </Notice>
        </section>
    );
}
