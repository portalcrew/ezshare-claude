import { Button } from "../components/ui/button.tsx";
import { Notice } from "../components/ui/notice.tsx";
import type { AccountCatalog } from "../view-models/account-catalog.ts";
import { accountsCopy, commonCopy, errorMessage, sharedAccountLabel } from "../view-models/copy.ts";
import type { AccountEditor } from "../view-models/sharing-store.ts";

function CatalogStatus({ catalog, onRetry }: { readonly catalog: AccountCatalog; readonly onRetry: () => void }) {
    switch (catalog.kind) {
        case "loading":
            return (
                <p role="status" aria-label={accountsCopy.title}>
                    {accountsCopy.loading}
                </p>
            );
        case "failed":
            return (
                <Notice tone="warning" title={accountsCopy.failed}>
                    <p>{errorMessage(catalog.code)}</p>
                    <Button variant="secondary" onClick={onRetry}>
                        {accountsCopy.retry}
                    </Button>
                </Notice>
            );
        case "ready":
            return catalog.items.length === 0 ? (
                <div className="space-y-2">
                    <p role="status" aria-label={accountsCopy.title} className="font-medium">
                        {accountsCopy.empty}
                    </p>
                    <p className="text-sm text-ink-3">{accountsCopy.emptyHint}</p>
                </div>
            ) : null;
        default:
            return catalog satisfies never;
    }
}

export function AccountsPicker({
    catalog,
    selected,
    disabled,
    onSelect,
    onRetry,
    onShare,
}: {
    readonly catalog: AccountCatalog;
    readonly selected: string | null;
    readonly disabled: boolean;
    readonly onSelect: (id: string) => void;
    readonly onRetry: () => void;
    readonly onShare: () => void;
}) {
    if (catalog.kind !== "ready" || catalog.items.length === 0) {
        return (
            <div className="space-y-3">
                <CatalogStatus catalog={catalog} onRetry={onRetry} />
                {catalog.kind === "ready" && <Button onClick={onShare}>{accountsCopy.share}</Button>}
            </div>
        );
    }
    if (catalog.items.length === 1 && catalog.items[0]?.id === selected) {
        // The only account is already chosen; a picker would just be another decision before waking Claude.
        // An account chosen earlier and then removed is never replaced silently, so that case still shows it.
        return null;
    }
    return (
        <label className="grid gap-2 text-sm font-medium">
            {accountsCopy.picker}
            <select
                value={selected ?? ""}
                disabled={disabled}
                onChange={(event) => onSelect(event.currentTarget.value)}
                className="min-h-11 min-w-0 rounded-[14px] border border-hairline bg-white px-3 text-ink"
            >
                <option value="" disabled>
                    {accountsCopy.choose}
                </option>
                {catalog.items.map((account) => (
                    <option key={account.id} value={account.id}>
                        {sharedAccountLabel(account)}
                    </option>
                ))}
            </select>
        </label>
    );
}

export function AccountsManager({
    catalog,
    editor,
    busy,
    onAdd,
    onEdit,
    onRemove,
    onCancel,
    onRetry,
}: {
    readonly catalog: AccountCatalog;
    readonly editor: AccountEditor;
    readonly busy: boolean;
    readonly onAdd: () => void;
    readonly onEdit: (id: string, operation: "replace" | "remove") => void;
    readonly onRemove: () => void;
    readonly onCancel: () => void;
    readonly onRetry: () => void;
}) {
    return (
        <section aria-label={accountsCopy.title} className="space-y-4">
            <h3 className="font-semibold">
                {catalog.kind === "ready" ? accountsCopy.count(catalog.items.length) : accountsCopy.title}
            </h3>
            <CatalogStatus catalog={catalog} onRetry={onRetry} />
            {catalog.kind === "ready" && (
                <>
                    <div className="divide-y divide-black/[0.06]">
                        {catalog.items.map((account) => (
                            <fieldset
                                key={account.id}
                                aria-label={sharedAccountLabel(account)}
                                className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
                            >
                                <div className="min-w-0 space-y-1">
                                    <p className="break-words font-medium">{sharedAccountLabel(account)}</p>
                                    <p className="text-xs text-ink-3">
                                        <span className="text-ok">{accountsCopy.shared}</span>
                                        {" · "}
                                        <time dateTime={account.updatedAt}>
                                            {accountsCopy.updated(account.updatedAt)}
                                        </time>
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-3">
                                    <Button
                                        variant="secondary"
                                        disabled={busy || editor.kind !== "closed"}
                                        onClick={() => onEdit(account.id, "replace")}
                                    >
                                        {accountsCopy.reauthorize}
                                    </Button>
                                    <Button
                                        variant="quiet"
                                        disabled={busy || editor.kind !== "closed"}
                                        onClick={() => onEdit(account.id, "remove")}
                                    >
                                        {accountsCopy.remove}
                                    </Button>
                                </div>
                            </fieldset>
                        ))}
                    </div>
                    {catalog.items.length > 0 && <p className="text-xs text-ink-3">{accountsCopy.availability}</p>}
                    {editor.kind === "closed" && (
                        <Button disabled={busy} onClick={onAdd}>
                            {accountsCopy.add}
                        </Button>
                    )}
                </>
            )}
            {editor.kind === "remove" && (
                <Notice tone="warning" title={accountsCopy.removeTitle(sharedAccountLabel(editor.account))}>
                    <div className="space-y-3">
                        <p>{accountsCopy.removeHint}</p>
                        <div className="flex flex-wrap gap-3">
                            <Button variant="danger" busy={busy} onClick={onRemove}>
                                {accountsCopy.removeAction}
                            </Button>
                            <Button variant="secondary" disabled={busy} onClick={onCancel}>
                                {commonCopy.cancel}
                            </Button>
                        </div>
                    </div>
                </Notice>
            )}
        </section>
    );
}

/** The team's accounts for someone who cannot change them: names and when each was last authorized. */
export function AccountsOverview({
    catalog,
    onRetry,
}: {
    readonly catalog: AccountCatalog;
    readonly onRetry: () => void;
}) {
    return (
        <section aria-label={accountsCopy.title} className="space-y-3">
            <CatalogStatus catalog={catalog} onRetry={onRetry} />
            {catalog.kind === "ready" && catalog.items.length > 0 && (
                <>
                    <p className="text-sm text-ink-3">{accountsCopy.readOnly}</p>
                    <ul className="divide-y divide-black/[0.06] rounded-[18px] bg-canvas">
                        {catalog.items.map((account) => (
                            <li key={account.id} className="px-4 py-3">
                                <p className="break-words font-medium">{sharedAccountLabel(account)}</p>
                                <p className="text-xs text-ink-3">
                                    <time dateTime={account.updatedAt}>{accountsCopy.updated(account.updatedAt)}</time>
                                </p>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}
