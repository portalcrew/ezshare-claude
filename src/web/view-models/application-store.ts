import { createStore } from "zustand/vanilla";
import type { Clock } from "../../shared/async.ts";
import { AppError, type ErrorCode, toAppError } from "../../shared/errors.ts";
import { GitHubClient, type GitHubUser, type Repository, repositoryName } from "../../shared/github/client.ts";
import type { Vault } from "../services/vault.ts";
import { type ChatStore, createChatStore } from "./chat-store.ts";
import { createSharingStore, type SharingStore } from "./sharing-store.ts";

/** Failures of connecting, including the launcher's own token policy. */
export type ConnectionError = ErrorCode | "classic_token";

export type Page = "use" | "share";

export interface Workspace {
    readonly id: number;
    readonly user: GitHubUser;
    readonly repository: Repository;
    readonly branchProtected: boolean;
    readonly chat: ChatStore;
    readonly sharing: SharingStore;
}

type ApplicationPhase =
    | { readonly kind: "restoring" }
    | { readonly kind: "disconnected"; readonly error: ConnectionError | null }
    | { readonly kind: "connecting" }
    | { readonly kind: "disconnecting" }
    | { readonly kind: "connected"; readonly workspace: Workspace };

export interface ApplicationState {
    readonly phase: ApplicationPhase;
    readonly page: Page;
}

export interface ApplicationActions {
    readonly open: () => void;
    readonly close: () => void;
    readonly connect: (input: { readonly repository: string; readonly token: string }) => void;
    readonly disconnect: () => void;
    readonly showPage: (page: Page) => void;
}

export type ApplicationStore = ReturnType<typeof createApplicationStore>;

export interface ApplicationPorts {
    readonly apiOrigin: string;
    readonly clock: Clock;
    readonly vault: Vault;
}

/** Fine-grained tokens are limited to the repositories and permissions the member selects. */
const FINE_GRAINED_TOKEN = /^github_pat_[A-Za-z0-9_]{20,250}$/u;

/** The connection to GitHub and the workspace that exists while connected. */
export function createApplicationStore(ports: ApplicationPorts) {
    let lifetime: AbortController | null = null;
    let attempt: AbortController | null = null;
    let sequence = 0;

    return createStore<ApplicationState & ApplicationActions>()((set, get) => {
        const closeWorkspace = () => {
            const phase = get().phase;
            if (phase.kind === "connected") {
                phase.workspace.chat.getState().close();
                phase.workspace.sharing.getState().close();
            }
        };

        const establish = async (
            input: { readonly repository: string; readonly token: string },
            expectedUserId: string | null,
            signal: AbortSignal,
        ): Promise<Workspace> => {
            const github = new GitHubClient(input.token, ports.apiOrigin);
            const user = await github.user(signal);
            if (expectedUserId !== null && user.id !== expectedUserId) {
                throw new AppError("unauthenticated");
            }
            const repository = await github.repository(input.repository, signal);
            const branchProtected = await github.branchProtected(repository, signal);
            const member = { github, user, repository, vault: ports.vault, clock: ports.clock };
            return {
                id: ++sequence,
                user,
                repository,
                branchProtected,
                chat: createChatStore(member),
                sharing: createSharingStore(member),
            };
        };

        const activate = (workspace: Workspace) => {
            closeWorkspace();
            set({ phase: { kind: "connected", workspace }, page: "use" });
            workspace.chat.getState().open();
            workspace.sharing.getState().open();
        };

        const begin = (): AbortSignal | null => {
            if (lifetime === null) {
                return null;
            }
            attempt?.abort(new DOMException("Replaced", "AbortError"));
            attempt = new AbortController();
            return AbortSignal.any([lifetime.signal, attempt.signal]);
        };

        return {
            phase: { kind: "restoring" },
            page: "use",
            open: () => {
                lifetime = new AbortController();
                const signal = begin();
                if (signal === null) {
                    return;
                }
                void (async () => {
                    try {
                        const saved = await ports.vault.loadConnection(signal);
                        if (saved === null) {
                            set({ phase: { kind: "disconnected", error: null } });
                            return;
                        }
                        const workspace = await establish(saved, saved.userId, signal);
                        if (!signal.aborted) {
                            activate(workspace);
                        }
                    } catch (cause) {
                        const error = toAppError(cause);
                        if (signal.aborted) {
                            return;
                        }
                        if (error.code === "unauthenticated") {
                            // The saved token expired or now belongs to someone else: never reuse it.
                            await ports.vault.forgetConnection(AbortSignal.timeout(8_000)).catch(() => undefined);
                        }
                        set({ phase: { kind: "disconnected", error: error.code } });
                    }
                })();
            },
            close: () => {
                closeWorkspace();
                lifetime?.abort(new DOMException("Closed", "AbortError"));
                lifetime = null;
            },
            connect: (input) => {
                const signal = begin();
                if (signal === null) {
                    return;
                }
                const token = input.token.trim();
                if (!FINE_GRAINED_TOKEN.test(token)) {
                    set({
                        phase: { kind: "disconnected", error: token.length === 0 ? "invalid_input" : "classic_token" },
                    });
                    return;
                }
                let repository: string;
                try {
                    repository = repositoryName(input.repository);
                } catch {
                    set({ phase: { kind: "disconnected", error: "invalid_input" } });
                    return;
                }
                closeWorkspace();
                set({ phase: { kind: "connecting" } });
                void (async () => {
                    try {
                        const workspace = await establish({ repository, token }, null, signal);
                        await ports.vault.saveConnection(
                            { version: 1, repository, userId: workspace.user.id, token },
                            signal,
                        );
                        if (!signal.aborted) {
                            activate(workspace);
                        }
                    } catch (cause) {
                        if (!signal.aborted) {
                            set({ phase: { kind: "disconnected", error: toAppError(cause).code } });
                        }
                    }
                })();
            },
            disconnect: () => {
                const signal = begin();
                if (signal === null) {
                    return;
                }
                closeWorkspace();
                set({ phase: { kind: "disconnecting" } });
                // The form returns only after the token is gone, so a reload cannot restore it.
                void ports.vault.forgetConnection(signal).then(
                    () => set({ phase: { kind: "disconnected", error: null } }),
                    (cause: unknown) => {
                        if (!signal.aborted) {
                            set({ phase: { kind: "disconnected", error: toAppError(cause).code } });
                        }
                    },
                );
            },
            showPage: (page) => set({ page }),
        };
    });
}
