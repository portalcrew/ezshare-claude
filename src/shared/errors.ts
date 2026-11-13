/** Stable machine-readable failure codes shared by the browser and the Actions runner. */
export type ErrorCode =
    | "cancelled"
    | "timeout"
    | "invalid_input"
    | "unauthenticated"
    | "forbidden"
    | "actions_read_forbidden"
    | "actions_write_forbidden"
    | "issues_read_forbidden"
    | "issues_write_forbidden"
    | "secrets_read_forbidden"
    | "secrets_write_forbidden"
    | "contents_read_forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "github_unavailable"
    | "invalid_response"
    | "unsafe_execution"
    | "session_busy"
    | "storage_unavailable"
    | "shared_account_missing"
    | "agent_failed"
    | "morty_unavailable"
    | "provider_failed"
    | "expired"
    | "unexpected";

/** A failure that crosses a module or process boundary. Its message is the code; copy belongs to the UI. */
export class AppError extends Error {
    override readonly name = "AppError";
    readonly code: ErrorCode;

    constructor(code: ErrorCode, options?: { readonly cause?: unknown }) {
        super(code, options?.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
    }
}

/** Translates any thrown value into a typed error, keeping cancellation and timeouts distinct. */
export function toAppError(cause: unknown): AppError {
    if (cause instanceof AppError) {
        return cause;
    }
    if (cause instanceof DOMException && cause.name === "AbortError") {
        return new AppError("cancelled", { cause });
    }
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
        return new AppError("timeout", { cause });
    }
    return new AppError("unexpected", { cause });
}

/** Throws a typed cancellation if the signal has been aborted. */
export function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new AppError("cancelled", { cause: signal.reason });
    }
}

/** Includes contextual GitHub denials while preserving the generic authorization error. */
export function isAccessDenied(code: ErrorCode | null): boolean {
    return (
        code === "forbidden" ||
        code === "actions_read_forbidden" ||
        code === "actions_write_forbidden" ||
        code === "issues_read_forbidden" ||
        code === "issues_write_forbidden" ||
        code === "secrets_read_forbidden" ||
        code === "secrets_write_forbidden" ||
        code === "contents_read_forbidden"
    );
}
