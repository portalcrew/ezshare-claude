import type { ErrorCode } from "../shared/errors.ts";

/** Failure codes the Morty CLI reports in its JSON error output. */
export const MORTY_ERROR_CODES = [
    "INVALID_REQUEST",
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

export type MortyFailureCode = (typeof MORTY_ERROR_CODES)[number] | (typeof NPM_ERROR_CODES)[number] | "UNRECOGNIZED";

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
