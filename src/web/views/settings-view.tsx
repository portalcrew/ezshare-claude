import type { ReactNode } from "react";
import { useStore } from "zustand";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import type { Workspace } from "../view-models/application-store.ts";
import { chatCopy, settingsCopy, workspaceCopy } from "../view-models/copy.ts";

/** Everything a member rarely needs: recovery options, what this browser keeps, privacy, and the GitHub sign-in. */
export function SettingsView({
    workspace,
    onSignOut,
}: {
    readonly workspace: Workspace;
    readonly onSignOut: () => void;
}) {
    const store = workspace.chat;
    const client = useStore(store, (state) => state.client);
    const command = useStore(store, (state) => state.command);
    const newMortyIdentity = useStore(store, (state) => state.newMortyIdentity);
    const { setNewMortyIdentity } = store.getState();
    const visibility = workspace.repository.isPrivate ? workspaceCopy.privateBody : workspaceCopy.publicBody;
    return (
        <Card title={settingsCopy.title}>
            {client === "morty" && (
                <Section title={settingsCopy.troubleshooting}>
                    <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                            type="checkbox"
                            checked={newMortyIdentity}
                            disabled={command !== null}
                            aria-describedby="new-morty-identity-hint"
                            onChange={(event) => setNewMortyIdentity(event.currentTarget.checked)}
                            className="size-4 accent-ink"
                        />
                        {chatCopy.newMortyIdentity}
                    </label>
                    <p id="new-morty-identity-hint" className="text-sm text-ink-3">
                        {settingsCopy.newMortyHint}
                    </p>
                </Section>
            )}
            <Section title={settingsCopy.workspaceKey}>
                <p className="text-sm text-ink-3">{workspaceCopy.historyPrivacy}</p>
            </Section>
            <Section title={settingsCopy.privacy}>
                <p className="text-sm text-ink-3">
                    {workspace.repository.isPrivate ? workspaceCopy.privateTitle : workspaceCopy.publicTitle}:{" "}
                    {visibility}
                </p>
                <p className="text-sm text-ink-3">{workspaceCopy.accountPrivacy}</p>
            </Section>
            <Section title={settingsCopy.github}>
                <p className="text-sm">
                    {workspaceCopy.signedInAs} <strong className="font-medium">{workspace.user.login}</strong>
                    {" · "}
                    {workspace.repository.name}
                </p>
                <p className="text-sm text-ink-3">{workspaceCopy.identityHint}</p>
                <Button variant="secondary" onClick={onSignOut}>
                    {workspaceCopy.signOut}
                </Button>
            </Section>
        </Card>
    );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
    return (
        <section aria-label={title} className="space-y-2 border-t border-black/[0.06] pt-4 first:border-t-0 first:pt-0">
            <h3 className="text-[13px] font-medium text-ink-3">{title}</h3>
            {children}
        </section>
    );
}
