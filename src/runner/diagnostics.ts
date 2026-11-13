import type { ErrorCode } from "../shared/errors.ts";

/** Failure codes the Morty CLI reports in its JSON error output. */
export const MORTY_ERROR_CODES = [
    "INVALID_REQUEST",
    "INVALID_RESPONSE",
    "HARNESS_UNAVAILABLE",
    "RUNTIME_START_FAILED",
    "SETUP_FAILED",
    "SETUP_TIMEOUT",
    "TIMEOUT",
] as const;

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
              | "saving_history"
              | "starting_agent"
              | "connecting_morty"
              | "ready"
              | "awaiting_authorization"
              | "completing_authorization"
              | "authorized"
              | "stopping"
              | "closed";
      }
    | { readonly event: "session.failed"; readonly code: ErrorCode }
    | {
          readonly event: "morty.failed";
          readonly code:
              | (typeof MORTY_ERROR_CODES)[number]
              | "UNRECOGNIZED"
              | "HANDOFF_MISMATCH"
              | "READY_OUTPUT_INVALID";
          readonly exitCode: number | null;
      };

export type Diagnostics = (record: DiagnosticRecord) => void;

export const writeDiagnostics: Diagnostics = (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`);
};
