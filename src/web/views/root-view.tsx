import { useStore } from "zustand";
import { isAccessDenied } from "../../shared/errors.ts";
import { ConnectionForm } from "../components/connection-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Announcer, Notice } from "../components/ui/notice.tsx";
import type { ApplicationStore, Page, Workspace } from "../view-models/application-store.ts";
import { errorMessage, tokenTemplates } from "../view-models/copy.ts";
import { ChatView } from "./chat-view.tsx";
import { SharingView } from "./sharing-view.tsx";

const PAGES: readonly { readonly page: Page; readonly label: string }[] = [
    { page: "use", label: "Use the team account" },
    { page: "share", label: "Share your account" },
];

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
                    ezshare-claude
                </p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                    One team account, private sessions.
                </h1>
                <p className="text-stone-600 dark:text-stone-400">
                    Use Claude Code with the account your team shares, in a session only you can reach.
                </p>
            </header>
            {phase.kind === "connected" ? (
                <Connected workspace={phase.workspace} page={page} store={store} now={now} />
            ) : (
                <section aria-label="Connect to GitHub" className="space-y-5">
                    <h2 className="text-xl font-semibold">Connect to GitHub</h2>
                    {(phase.kind === "restoring" || phase.kind === "disconnecting") && (
                        <p aria-busy="true" className="text-sm">
                            {phase.kind === "restoring" ? "Restoring your connection…" : "Removing your token…"}
                        </p>
                    )}
                    {phase.kind === "disconnected" && phase.error !== null && (
                        <Notice tone="error" title="Could not connect">
                            {errorMessage(phase.error)}
                        </Notice>
                    )}
                    {(phase.kind === "disconnected" || phase.kind === "connecting") && (
                        <ConnectionForm
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
                    GitHub identity verified as <strong>{workspace.user.login}</strong> for{" "}
                    <strong>{workspace.repository.name}</strong>
                </p>
                <Button variant="quiet" onClick={actions.disconnect}>
                    Disconnect
                </Button>
            </div>
            <p className="text-sm text-stone-600 dark:text-stone-400">
                This verifies your identity and repository access. Session and account-sharing permissions are checked
                when you use them.
            </p>
            <TokenAccessNotice workspace={workspace} onReplace={actions.disconnect} />
            {!workspace.repository.isPrivate && (
                <Notice tone="info" title="This repository is public">
                    Anyone can see when sessions start and end. What you type, links and tokens are encrypted between
                    your browser and your session.
                </Notice>
            )}
            <nav aria-label="Sections" className="flex gap-2 border-b border-stone-200 dark:border-stone-800">
                {PAGES.map((item) => (
                    <button
                        key={item.page}
                        type="button"
                        aria-current={page === item.page ? "page" : undefined}
                        onClick={() => actions.showPage(item.page)}
                        className="-mb-px min-h-11 border-b-2 border-transparent px-3 text-sm font-semibold text-stone-600 outline-none hover:text-stone-900 focus-visible:ring-[3px] focus-visible:ring-emerald-600/60 aria-[current=page]:border-emerald-700 aria-[current=page]:text-emerald-900 dark:text-stone-300 dark:hover:text-white dark:aria-[current=page]:border-emerald-400 dark:aria-[current=page]:text-emerald-200"
                    >
                        {item.label}
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
        <section aria-label="GitHub access needs attention">
            <Announcer message="GitHub denied an operation. Review your token permissions or replace your token." />
            <Notice tone="warning" title="GitHub access needs attention">
                <div className="space-y-3">
                    {chatDenied !== null && <p>{errorMessage(chatDenied)}</p>}
                    {sharingDenied !== null && sharingDenied !== chatDenied && <p>{errorMessage(sharingDenied)}</p>}
                    <p>
                        GitHub recognizes you, but denied an operation in <strong>{workspace.repository.name}</strong>.
                        Signing in does not grant permission to start sessions or share an account.
                    </p>
                    <p>
                        Select <strong>{templates.owner}</strong> as the token's resource owner and allow access to
                        <strong> {workspace.repository.name}</strong>. Sessions need Actions and Issues read and write.{" "}
                        Sharing your account also needs Secrets read and write. If the token is pending organization
                        approval, ask an organization owner to approve it. Your GitHub account also needs write access
                        to the repository.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <ExternalLink href={templates.member}>Create a token to use the team account</ExternalLink>
                        <ExternalLink href={templates.ownerSharing}>
                            Create a token to share my Claude account
                        </ExternalLink>
                        <Button variant="secondary" onClick={onReplace}>
                            Replace GitHub token
                        </Button>
                    </div>
                    <p>
                        Replacing the token disconnects this browser. It does not stop a running session or erase
                        history keys.
                    </p>
                </div>
            </Notice>
        </section>
    );
}
