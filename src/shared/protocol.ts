import * as v from "valibot";
import { AppError } from "./errors.ts";

/** A session is one workflow run that serves exactly one purpose for one member. */
export type Purpose = "chat" | "login";

const CHAT_LIFETIME_MS = 60 * 60_000;
const LOGIN_LIFETIME_MS = 15 * 60_000;
export const SHARED_SECRET_NAME = "EZSHARE_CLAUDE_TOKEN";

export function lifetime(purpose: Purpose): number {
    switch (purpose) {
        case "chat":
            return CHAT_LIFETIME_MS;
        case "login":
            return LOGIN_LIFETIME_MS;
        default:
            return purpose satisfies never;
    }
}

export function workflowPath(purpose: Purpose): string {
    return `.github/workflows/${purpose}.yml`;
}

export const requestIdSchema = v.pipe(v.string(), v.uuid());
export const userIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,15}$/u));
export const runIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,18}$/u));
/** An X25519 public key: 32 bytes as canonical unpadded base64url. */
export const channelKeySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u));

/** The workflow_dispatch inputs. They are fixed when the member's own token dispatches the run. */
export const dispatchInputsSchema = v.object({
    request_id: requestIdSchema,
    issue: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,15}$/u)),
    client_key: channelKeySchema,
});
export type DispatchInputs = Readonly<v.InferOutput<typeof dispatchInputsSchema>>;

/** The run name declared by every session workflow: `ezshare-<actor id>-<request id>`. */
export function runName(userId: string, requestId: string): string {
    return `ezshare-${userId}-${requestId}`;
}

export function runNamePrefix(userId: string): string {
    return `ezshare-${userId}-`;
}

export function issueTitle(purpose: Purpose, requestId: string): string {
    return `ezshare ${purpose} session ${requestId}`;
}

export const ISSUE_BODY =
    "This issue is the encrypted mailbox of one ezshare-claude session. It closes when the session ends. " +
    "Please do not comment here.";

const SIGNER_PREFIX = "ezshare-channel-";

/** The artifact a run uploads to publish its channel key. Only that run can add artifacts to itself. */
export function signerArtifactName(runnerKey: string): string {
    return `${SIGNER_PREFIX}${runnerKey}`;
}

/** The channel key a run published, `null` before it has, or a failure if the run published anything else. */
export function publishedRunnerKey(names: readonly string[]): string | null {
    const keys = names.filter((name) => name.startsWith(SIGNER_PREFIX)).map((name) => name.slice(SIGNER_PREFIX.length));
    const [key, ...others] = keys;
    if (key === undefined) {
        return null;
    }
    if (others.length > 0 || !v.is(channelKeySchema, key)) {
        throw new AppError("unsafe_execution");
    }
    return key;
}

/** Everything a channel's keys are bound to. A message for another binding never decrypts. */
export interface ChannelBinding {
    readonly repository: string;
    readonly purpose: Purpose;
    readonly issue: number;
    readonly requestId: string;
    readonly runId: string;
    readonly userId: string;
}

export function bindingText(binding: ChannelBinding): string {
    return JSON.stringify([
        "ezshare/v1",
        binding.repository,
        binding.purpose,
        binding.issue,
        binding.requestId,
        binding.runId,
        binding.userId,
    ]);
}

export type Sender = "browser" | "runner";

const sequenceSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000));
const sealedTextSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/u), v.maxLength(64_000));

/** A posted comment. Its header is authenticated as associated data; its body is encrypted. */
export const envelopeSchema = v.strictObject({
    ezshare: v.literal(1),
    requestId: requestIdSchema,
    runId: runIdSchema,
    sender: v.picklist(["browser", "runner"]),
    sequence: sequenceSchema,
    kind: v.picklist(["challenge", "code", "token", "ready", "stop", "stopped", "failed"]),
    nonce: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16}$/u)),
    data: sealedTextSchema,
});
type Envelope = Readonly<v.InferOutput<typeof envelopeSchema>>;
export type EnvelopeHeader = Omit<Envelope, "nonce" | "data">;

export function headerText(header: EnvelopeHeader): string {
    return JSON.stringify([
        header.ezshare,
        header.requestId,
        header.runId,
        header.sender,
        header.sequence,
        header.kind,
    ]);
}

export const authorizationCodeSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_\-#.~]{10,2048}$/u));
export const claudeTokenSchema = v.pipe(v.string(), v.regex(/^sk-ant-oat01-[A-Za-z0-9_-]{20,2048}$/u));

/** Failure codes a runner may report to the browser. */
export const runnerFailureSchema = v.strictObject({
    code: v.picklist([
        "timeout",
        "unsafe_execution",
        "shared_account_missing",
        "agent_failed",
        "morty_unavailable",
        "provider_failed",
        "github_unavailable",
        "rate_limited",
        "unexpected",
    ]),
});
export type RunnerFailure = v.InferOutput<typeof runnerFailureSchema>["code"];

/** Messages per channel direction. Any other kind on a channel is a protocol violation. */
export const chatRunnerMessageSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("ready"),
        body: v.strictObject({
            url: v.pipe(v.string(), v.maxLength(8192)),
            accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        }),
    }),
    v.strictObject({ kind: v.literal("stopped"), body: v.strictObject({}) }),
    v.strictObject({ kind: v.literal("failed"), body: runnerFailureSchema }),
]);
export const chatBrowserMessageSchema = v.variant("kind", [
    v.strictObject({ kind: v.literal("stop"), body: v.strictObject({}) }),
]);
export const loginRunnerMessageSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("challenge"),
        body: v.strictObject({ url: v.pipe(v.string(), v.maxLength(8192)) }),
    }),
    v.strictObject({ kind: v.literal("token"), body: v.strictObject({ token: claudeTokenSchema }) }),
    v.strictObject({ kind: v.literal("failed"), body: runnerFailureSchema }),
]);
export const loginBrowserMessageSchema = v.variant("kind", [
    v.strictObject({ kind: v.literal("code"), body: v.strictObject({ code: authorizationCodeSchema }) }),
]);

export type ChatRunnerMessage = v.InferOutput<typeof chatRunnerMessageSchema>;
export type ChatBrowserMessage = v.InferOutput<typeof chatBrowserMessageSchema>;
export type LoginRunnerMessage = v.InferOutput<typeof loginRunnerMessageSchema>;
export type LoginBrowserMessage = v.InferOutput<typeof loginBrowserMessageSchema>;

/** Accepts only the Claude authorization page, so a challenge can never send the owner elsewhere. */
export function authorizationUrl(value: string): string {
    const url = parseUrl(value);
    if (
        url.protocol !== "https:" ||
        !["claude.ai", "claude.com"].includes(url.hostname) ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        !["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname) ||
        url.hash !== ""
    ) {
        throw new AppError("invalid_response");
    }
    return url.href;
}

/** Accepts only a Morty continuation link for a Claude session. */
export function mortyUrl(value: string): string {
    const url = parseUrl(value);
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    if (
        url.origin !== "https://morty.build" ||
        url.pathname !== "/continue" ||
        url.username !== "" ||
        url.password !== "" ||
        code === null ||
        code.length === 0 ||
        code.length > 4096 ||
        url.searchParams.get("harness") !== "claude" ||
        !v.is(requestIdSchema, url.searchParams.get("sessionId"))
    ) {
        throw new AppError("invalid_response");
    }
    return url.href;
}

function parseUrl(value: string): URL {
    if (value.length > 8192) {
        throw new AppError("invalid_response");
    }
    try {
        return new URL(value);
    } catch (cause) {
        throw new AppError("invalid_response", { cause });
    }
}

export function parseJson(text: string): unknown {
    try {
        const value: unknown = JSON.parse(text);
        return value;
    } catch (cause) {
        throw new AppError("invalid_response", { cause });
    }
}
