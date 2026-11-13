import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { type Clock, systemClock } from "../shared/async.ts";
import { GITHUB_API_ORIGIN } from "../shared/github/http.ts";
import { createBrowserVault } from "./services/vault.ts";
import { createApplicationStore } from "./view-models/application-store.ts";
import { RootView } from "./views/root-view.tsx";

export interface LauncherOptions {
    readonly apiOrigin?: string;
    readonly clock?: Clock;
}

/** Composes and starts the launcher; the returned function ends every workflow it started. */
export function mountLauncher(root: HTMLElement, options: LauncherOptions = {}): () => void {
    const apiOrigin = options.apiOrigin ?? GITHUB_API_ORIGIN;
    const clock = options.clock ?? systemClock;
    const store = createApplicationStore({ apiOrigin, clock, vault: createBrowserVault(apiOrigin) });
    const view = createRoot(root);
    view.render(
        <StrictMode>
            <RootView store={store} now={clock.now} />
        </StrictMode>,
    );
    store.getState().open();
    return () => {
        store.getState().close();
        view.unmount();
    };
}
