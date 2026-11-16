import type { ErrorCode } from "../shared/errors.ts";

/** Failure codes the Morty CLI reports in its JSON error output. */
export const MORTY_ERROR_CODES = [
    "INVALID_REQUEST",
    "INVALID_ARGUMENTS",
    "INVALID_ORIGIN",
    "INVALID_HANDOFF",
    "INVALID_ENCRYPTION_HANDOFF",
    "BASE_URL_REQUIRED",
    "HARNESS_REQUIRED",
    "SESSION_ID_REQUIRED",
    "WORKING_DIRECTORY_REQUIRED",
    "WORKING_DIRECTORY_UNAVAILABLE",
    "UNSAFE_WORKING_DIRECTORY",
    "UNSAFE_CONFIG_PATH",
    "LOCAL_IDENTITY_REQUIRED",
    "LOCAL_CREDENTIAL_UNAVAILABLE",
    "IDENTITY_CONFLICT",
    "IDENTITY_UNAVAILABLE",
    "COMPUTER_CONFLICT",
    "INVALID_ACCOUNT_ID",
    "BOT_NOT_FOUND",
    "DEVICE_NOT_FOUND",
    "COMPUTER_REQUIRED",
    "METHOD_NOT_ALLOWED",
    "COMPUTER_NOT_FOUND",
    "COMPUTER_OBJECT_UNAVAILABLE",
    "COMPUTER_PAIRING_UNAVAILABLE",
    "NO_ACTIVE_COMPUTER",
    "INVALID_SESSION",
    "INVALID_SESSION_ACCESS",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "RELAY_TIMEOUT",
    "RELAY_UNAVAILABLE",
    "TRANSFER_UNAVAILABLE",
    "QR_DECODER_UNAVAILABLE",
    "QR_VERIFICATION_FAILED",
    "INVALID_RESPONSE",
    "INVALID_CONFIGURATION",
    "MORTY_STATE_ROOT_INVALID",
    "SAVED_IDENTITY_ORIGIN_MISMATCH",
    "COMPUTER_REPLACEMENT_REQUIRED",
    "HARNESS_UNAVAILABLE",
    "RUNTIME_START_FAILED",
    "SETUP_FAILED",
    "SETUP_TIMEOUT",
    "TIMEOUT",
] as const;

/** npm failures are separate from Morty failures: installation can fail before the CLI runs. */
export const NPM_ERROR_CODES = [
    "ENOENT",
    "ENOTDIR",
    "EEXIST",
    "ENOSPC",
    "EIO",
    "ETARGET",
    "E404",
    "EJSONPARSE",
    "E401",
    "E403",
    "EACCES",
    "EPERM",
    "EBADENGINE",
    "EUNSUPPORTEDPROTOCOL",
    "EOVERRIDE",
    "ENOTFOUND",
    "ECONNRESET",
    "ETIMEDOUT",
] as const;

export const STARTUP_ERROR_CODES = [
    "ERR_MODULE_NOT_FOUND",
    "MODULE_NOT_FOUND",
    "ERR_REQUIRE_ESM",
    "ERR_UNKNOWN_FILE_EXTENSION",
    "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
    "NODE_RUNTIME_INCOMPATIBLE",
    "CLI_ARGUMENT_REJECTED",
    "DAEMON_FAILED",
    "NPM_FAILED",
] as const;

export type MortyOutputFormat = "empty" | "json" | "ndjson" | "text";

export type MortyFailureCode =
    | (typeof MORTY_ERROR_CODES)[number]
    | (typeof NPM_ERROR_CODES)[number]
    | (typeof STARTUP_ERROR_CODES)[number]
    | "UNRECOGNIZED";

/**
 * Structured progress written to the public workflow log. Records carry stages and codes only, never tokens,
 * links, authorization codes or conversation content.
 */
export type DiagnosticRecord =
    | {
          readonly event: "session.stage";
          readonly stage:
              | "verifying"
              | "verified"
              | "awaiting_history"
              | "restoring_history"
              | "verified_history"
              | "saving_history"
              | "starting_agent"
              | "connecting_morty"
              | "ready"
              | "idle"
              | "awaiting_authorization"
              | "completing_authorization"
              | "authorized"
              | "stopping"
              | "closed";
      }
    | { readonly event: "morty.output"; readonly stdout: MortyOutputFormat; readonly stderr: MortyOutputFormat }
    | { readonly event: "morty.retrying"; readonly code: "ETARGET"; readonly attempt: number }
    | { readonly event: "session.failed"; readonly code: ErrorCode }
    | {
          readonly event: "morty.failed";
          readonly code: MortyFailureCode | "HANDOFF_MISMATCH" | "READY_OUTPUT_INVALID";
          readonly exitCode: number | null;
      };

export type Diagnostics = (record: DiagnosticRecord) => void;

export const writeDiagnostics: Diagnostics = (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`);
};
