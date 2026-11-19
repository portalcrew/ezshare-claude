import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { Clock } from "../../shared/async.ts";
import { isAccessDenied } from "../../shared/errors.ts";
import { ConnectionChoices, ConnectionForm } from "../components/connection-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { ExternalLink } from "../components/ui/external-link.tsx";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/menu.tsx";
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
import { SettingsView } from "./settings-view.tsx";
import { TeamAccounts } from "./sharing-view.tsx";

export function RootView({
    store,
    clock,
    defaultRepository,
    authorizationAvailable,
}: {
    readonly store: ApplicationStore;
    readonly clock: Clock;
    readonly defaultRepository: string;
    readonly authorizationAvailable: boolean;
}) {
    const phase = useStore(store, (state) => state.phase);
    const page = useStore(store, (state) => state.page);
    const actions = store.getState();
    if (phase.kind === "connected") {
        return <Connected workspace={phase.workspace} page={page} store={store} clock={clock} />;
    }
    const manual = (
        <ConnectionForm
            copy={connectionFormCopy}
            initialRepository={defaultRepository}
            templatesFor={tokenTemplates}
            busy={phase.kind === "connecting"}
            onConnect={actions.connect}
        />
    );
    return (
        <Shell>
            <div className="mx-auto max-w-md space-y-8 pt-6 sm:pt-14">
                <header className="space-y-3 text-center">
                    <h1 className="text-balance text-[28px] leading-9 font-semibold tracking-[-0.01em]">
                        {launcherCopy.headline}
                    </h1>
                    <p className="text-pretty text-ink-3">{launcherCopy.tagline}</p>
                </header>
                <section aria-label={connectCopy.title} className="space-y-5">
                    <h2 className="sr-only">{connectCopy.title}</h2>
                    {(phase.kind === "restoring" || phase.kind === "disconnecting") && (
                        <p aria-busy="true" className="text-center text-sm text-ink-3">
                            {phase.kind === "restoring" ? connectCopy.restoring : connectCopy.disconnecting}
                        </p>
                    )}
                    {phase.kind === "disconnected" && phase.error !== null && (
                        <Notice tone="error" title={connectCopy.failedTitle}>
                            {errorMessage(phase.error)}
                        </Notice>
                    )}
                    {phase.kind === "authorizing" && (
                        <p role="status" className="text-center text-sm text-ink-3">
                            {connectCopy.authorizing}
                        </p>
                    )}
                    {(phase.kind === "disconnected" || phase.kind === "connecting") &&
                        (authorizationAvailable ? (
                            <ConnectionChoices
                                repository={defaultRepository}
                                authorize={connectCopy.authorize}
                                manual={connectCopy.manual}
                                back={connectCopy.back}
                                hint={connectCopy.authorizationHint}
                                onAuthorize={actions.authorize}
                            >
                                {manual}
                            </ConnectionChoices>
                        ) : (
                            manual
                        ))}
                </section>
            </div>
        </Shell>
    );
}

/** The page frame: the product mark on the left and, once signed in, the account menu on the right. */
function Shell({ menu, children }: { readonly menu?: ReactNode; readonly children: ReactNode }) {
    return (
        <div className="mx-auto min-h-dvh max-w-xl px-4 pb-10 sm:px-6">
            <div className="flex min-h-16 items-center justify-between">
                <p className="flex items-center gap-2 text-[15px] font-semibold">
                    <span
                        aria-hidden="true"
                        className="size-6 rounded-[7px] bg-[linear-gradient(135deg,#ffd6a5,#f4a7d8_45%,#4f7cff)]"
                    />
                    {launcherCopy.product}
                </p>
                {menu}
            </div>
            {children}
        </div>
    );
}

function Connected({
    workspace,
    page,
    store,
    clock,
}: {
    readonly workspace: Workspace;
    readonly page: Page;
    readonly store: ApplicationStore;
    readonly clock: Clock;
}) {
    const actions = store.getState();
    const menu = (
        <Menu label={workspaceCopy.menu} trigger={workspace.user.login.slice(0, 1).toUpperCase()}>
            {(close) => {
                const go = (target: Page) => () => {
                    close();
                    actions.showPage(target);
                };
                return (
                    <>
                        <p className="px-3 pt-2.5 pb-2 text-xs leading-5 text-ink-3">
                            {workspaceCopy.signedInAs}
                            <br />
                            <strong className="text-sm font-medium text-ink">{workspace.user.login}</strong>
                            {" · "}
                            {workspace.repository.name}
                        </p>
                        <MenuSeparator />
                        <MenuItem onSelect={go("home")}>{workspaceCopy.pages.home}</MenuItem>
                        <MenuItem onSelect={go("accounts")}>{workspaceCopy.pages.accounts}</MenuItem>
                        <MenuItem onSelect={go("settings")}>{workspaceCopy.pages.settings}</MenuItem>
                        <MenuSeparator />
                        <MenuItem
                            tone="danger"
                            onSelect={() => {
                                close();
                                actions.disconnect();
                            }}
                        >
                            {workspaceCopy.signOut}
                        </MenuItem>
                    </>
                );
            }}
        </Menu>
    );
    return (
        <Shell menu={menu}>
            <h1 className="sr-only">{launcherCopy.product}</h1>
            <div className="space-y-5">
                <TokenAccessNotice workspace={workspace} onReplace={actions.disconnect} />
                {page === "home" ? null : (
                    <Button variant="quiet" className="no-underline" onClick={() => actions.showPage("home")}>
                        <span aria-hidden="true">‹</span>
                        {workspaceCopy.back}
                    </Button>
                )}
                {(() => {
                    switch (page) {
                        case "home":
                            return (
                                <>
                                    <ChatView
                                        onShare={() => actions.showPage("accounts")}
                                        store={workspace.chat}
                                        repository={workspace.repository.name}
                                        clock={clock}
                                    />
                                    <p className="text-center text-xs text-ink-3">
                                        <span>{workspace.user.login}</span>
                                        {" · "}
                                        {workspace.repository.name}
                                    </p>
                                </>
                            );
                        case "accounts":
                            return <TeamAccounts workspace={workspace} />;
                        case "settings":
                            return <SettingsView workspace={workspace} onSignOut={actions.disconnect} />;
                        default:
                            return page satisfies never;
                    }
                })()}
            </div>
        </Shell>
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
        isAccessDenied(state.commandError)
            ? state.commandError
            : isAccessDenied(state.problem)
              ? state.problem
              : state.accounts.kind === "failed" && isAccessDenied(state.accounts.code)
                ? state.accounts.code
                : null,
    );
    const sharingDenied = useStore(workspace.sharing, (state) =>
        isAccessDenied(state.commandError)
            ? state.commandError
            : isAccessDenied(state.problem)
              ? state.problem
              : state.accounts.kind === "failed" && isAccessDenied(state.accounts.code)
                ? state.accounts.code
                : null,
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
