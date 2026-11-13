import * as v from "valibot";
import { withDeadline } from "../../shared/async.ts";
import { decodeBase64Url, encodeBase64Url } from "../../shared/base64url.ts";
import type { ChannelKey } from "../../shared/channel-crypto.ts";
import { AppError } from "../../shared/errors.ts";
import { channelKeySchema, type Purpose, parseJson, requestIdSchema, userIdSchema } from "../../shared/protocol.ts";

/**
 * Browser storage for this origin. The GitHub token is encrypted under a non-extractable key kept beside it, which
 * protects copies of the profile on disk; it is not a defense against script on the same origin. The launcher must
 * therefore be served from an origin of its own.
 */

const DATABASE = "ezshare-claude";
const STORE = "vault";
const VAULT_KEY = "vault-key";
const STORAGE_TIMEOUT_MS = 8_000;

const connectionSchema = v.strictObject({
    version: v.literal(1),
    repository: v.pipe(v.string(), v.maxLength(140)),
    userId: userIdSchema,
    token: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
type SavedConnection = Readonly<v.InferOutput<typeof connectionSchema>>;

/** A session this browser started and may still need to observe, stop or finish. */
export interface PendingSession {
    readonly purpose: Purpose;
    readonly repository: string;
    readonly userId: string;
    readonly requestId: string;
    readonly issue: number;
    readonly startedAt: number;
    readonly key: ChannelKey;
}

const pendingSchema = v.strictObject({
    version: v.literal(1),
    purpose: v.picklist(["chat", "login"]),
    repository: v.pipe(v.string(), v.maxLength(140)),
    userId: userIdSchema,
    requestId: requestIdSchema,
    issue: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    startedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    publicKey: channelKeySchema,
    privateKey: v.instance(CryptoKey),
});

export interface Vault {
    readonly saveConnection: (connection: SavedConnection, signal: AbortSignal) => Promise<void>;
    readonly loadConnection: (signal: AbortSignal) => Promise<SavedConnection | null>;
    readonly forgetConnection: (signal: AbortSignal) => Promise<void>;
    readonly savePending: (session: PendingSession, signal: AbortSignal) => Promise<void>;
    readonly loadPending: (
        purpose: Purpose,
        repository: string,
        userId: string,
        signal: AbortSignal,
    ) => Promise<PendingSession | null>;
    readonly forgetPending: (
        purpose: Purpose,
        repository: string,
        userId: string,
        signal: AbortSignal,
    ) => Promise<void>;
}

const pendingSlot = (purpose: Purpose, repository: string, userId: string) =>
    `pending:${purpose}:${repository}:${userId}`;

export function createBrowserVault(apiOrigin: string): Vault {
    const connectionSlot = `connection:${apiOrigin}`;
    return {
        saveConnection: async (connection, signal) => {
            const key = await vaultKey(signal);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const data = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(connectionSlot) },
                key,
                new TextEncoder().encode(JSON.stringify(connection)),
            );
            await put(connectionSlot, { iv: encodeBase64Url(iv), data: encodeBase64Url(data) }, signal);
        },
        loadConnection: async (signal) => {
            const record = v.safeParse(
                v.object({ iv: v.string(), data: v.pipe(v.string(), v.maxLength(16_000)) }),
                await get(connectionSlot, signal),
            );
            if (!record.success) {
                return null;
            }
            try {
                const plain = await crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: decodeBase64Url(record.output.iv),
                        additionalData: new TextEncoder().encode(connectionSlot),
                    },
                    await vaultKey(signal),
                    decodeBase64Url(record.output.data),
                );
                const connection = v.safeParse(connectionSchema, parseJson(new TextDecoder().decode(plain)));
                return connection.success ? connection.output : null;
            } catch {
                // An unreadable record is discarded rather than trusted.
                return null;
            }
        },
        forgetConnection: (signal) => remove(connectionSlot, signal),
        savePending: (session, signal) =>
            put(
                pendingSlot(session.purpose, session.repository, session.userId),
                {
                    version: 1,
                    purpose: session.purpose,
                    repository: session.repository,
                    userId: session.userId,
                    requestId: session.requestId,
                    issue: session.issue,
                    startedAt: session.startedAt,
                    publicKey: session.key.publicKey,
                    privateKey: session.key.privateKey,
                },
                signal,
            ),
        loadPending: async (purpose, repository, userId, signal) => {
            const record = v.safeParse(pendingSchema, await get(pendingSlot(purpose, repository, userId), signal));
            if (
                !record.success ||
                record.output.purpose !== purpose ||
                record.output.repository !== repository ||
                record.output.userId !== userId ||
                record.output.privateKey.extractable ||
                record.output.privateKey.algorithm.name !== "X25519"
            ) {
                return null;
            }
            const { publicKey, privateKey, version: _version, ...session } = record.output;
            return { ...session, key: { publicKey, privateKey } };
        },
        forgetPending: (purpose, repository, userId, signal) =>
            remove(pendingSlot(purpose, repository, userId), signal),
    };
}

async function vaultKey(signal: AbortSignal): Promise<CryptoKey> {
    const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const selected = await transaction("readwrite", signal, (store, settle) => {
        const request = store.get(VAULT_KEY);
        request.onsuccess = () => {
            const current: unknown = request.result;
            if (current === undefined) {
                store.put(candidate, VAULT_KEY);
                settle(candidate);
            } else {
                settle(current);
            }
        };
    });
    const parsed = v.safeParse(v.instance(CryptoKey), selected);
    if (!parsed.success || parsed.output.extractable || parsed.output.algorithm.name !== "AES-GCM") {
        throw new AppError("storage_unavailable");
    }
    return parsed.output;
}

const get = (slot: string, signal: AbortSignal): Promise<unknown> =>
    transaction("readonly", signal, (store, settle) => {
        const request = store.get(slot);
        request.onsuccess = () => settle(request.result);
    });

const put = async (slot: string, value: unknown, signal: AbortSignal): Promise<void> => {
    await transaction("readwrite", signal, (store, settle) => {
        store.put(value, slot).onsuccess = () => settle(undefined);
    });
};

const remove = async (slot: string, signal: AbortSignal): Promise<void> => {
    await transaction("readwrite", signal, (store, settle) => {
        store.delete(slot).onsuccess = () => settle(undefined);
    });
};

/** Runs one IndexedDB transaction. The value settles only once the transaction commits. */
function transaction(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    operation: (store: IDBObjectStore, settle: (value: unknown) => void) => void,
): Promise<unknown> {
    return withDeadline(STORAGE_TIMEOUT_MS, signal, async (bounded) => {
        const database = await openDatabase(bounded);
        try {
            return await new Promise<unknown>((resolve, reject) => {
                const transaction = database.transaction(STORE, mode);
                let value: unknown;
                const abort = () => {
                    try {
                        transaction.abort();
                    } catch {
                        /* Already finished. */
                    }
                };
                bounded.addEventListener("abort", abort, { once: true });
                transaction.oncomplete = () => {
                    bounded.removeEventListener("abort", abort);
                    resolve(value);
                };
                transaction.onabort = () => {
                    bounded.removeEventListener("abort", abort);
                    reject(new AppError(bounded.aborted ? "cancelled" : "storage_unavailable"));
                };
                try {
                    operation(transaction.objectStore(STORE), (settled) => {
                        value = settled;
                    });
                } catch (cause) {
                    abort();
                    reject(new AppError("storage_unavailable", { cause }));
                }
            });
        } finally {
            database.close();
        }
    });
}

function openDatabase(signal: AbortSignal): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new AppError("storage_unavailable"));
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        const abort = () => reject(new AppError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE);
        };
        request.onerror = () => {
            signal.removeEventListener("abort", abort);
            reject(new AppError("storage_unavailable", { cause: request.error }));
        };
        request.onblocked = () => {
            signal.removeEventListener("abort", abort);
            reject(new AppError("storage_unavailable"));
        };
        request.onsuccess = () => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) {
                request.result.close();
                return;
            }
            resolve(request.result);
        };
    });
}
