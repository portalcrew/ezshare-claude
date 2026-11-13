import * as v from "valibot";
import { type ChannelKeys, open, seal } from "./channel-crypto.ts";
import { AppError } from "./errors.ts";
import type { GitHubClient } from "./github/client.ts";
import { type ChannelBinding, type EnvelopeHeader, envelopeSchema, parseJson, type Sender } from "./protocol.ts";

/** The shape of every session message schema: a `kind` tag and its body. */
export type MessageSchema = v.GenericSchema<unknown, { readonly kind: string; readonly body: unknown }>;
type Kind<TSchema extends MessageSchema> = v.InferOutput<TSchema>["kind"];

export type Received<TSchema extends MessageSchema> = v.InferOutput<TSchema> & { readonly sequence: number };

/**
 * An encrypted, authenticated message channel carried by the comments of one Issue.
 *
 * Issue comments are only a transport: comment authorship is not trusted, because every member can post as the
 * Actions bot. A comment is a message of this channel only if it decrypts under the peer's direction key. Messages
 * that do not are ignored, so noise cannot block a session.
 */
export class SessionChannel<TOutbound extends MessageSchema, TInbound extends MessageSchema> {
    readonly #github: GitHubClient;
    readonly #binding: ChannelBinding;
    readonly #self: Sender;
    readonly #keys: ChannelKeys;
    readonly #outbound: TOutbound;
    readonly #inbound: TInbound;
    #sequence = 0;

    constructor(options: {
        readonly github: GitHubClient;
        readonly binding: ChannelBinding;
        readonly self: Sender;
        readonly keys: ChannelKeys;
        readonly outbound: TOutbound;
        readonly inbound: TInbound;
    }) {
        this.#github = options.github;
        this.#binding = options.binding;
        this.#self = options.self;
        this.#keys = options.keys;
        this.#outbound = options.outbound;
        this.#inbound = options.inbound;
    }

    /** Posts one message. A failed post is ambiguous; callers that retry resend the same intent idempotently. */
    readonly send = async (message: v.InferOutput<TOutbound>, signal: AbortSignal): Promise<void> => {
        const checked = v.safeParse(this.#outbound, message);
        if (!checked.success) {
            throw new AppError("invalid_input");
        }
        await this.#ensureSequence(signal);
        this.#sequence += 1;
        const header: EnvelopeHeader = {
            ezshare: 1,
            requestId: this.#binding.requestId,
            runId: this.#binding.runId,
            sender: this.#self,
            sequence: this.#sequence,
            kind: kindOf(checked.output.kind),
        };
        const sealed = await seal(this.#keys.send, header, checked.output.body);
        await this.#github.comment(
            this.#binding.repository,
            this.#binding.issue,
            JSON.stringify({ ...header, ...sealed }),
            signal,
        );
    };

    /** Every authentic message from the peer, once per sequence number, in order. */
    readonly receive = async (signal: AbortSignal): Promise<readonly Received<TInbound>[]> => {
        const peer: Sender = this.#self === "browser" ? "runner" : "browser";
        const messages = new Map<number, Received<TInbound>>();
        for (const comment of await this.#github.comments(this.#binding.repository, this.#binding.issue, signal)) {
            const message = await this.#decode(comment.body, peer);
            if (message !== null && !messages.has(message.sequence)) {
                messages.set(message.sequence, message);
            }
        }
        return [...messages.values()].sort((first, second) => first.sequence - second.sequence);
    };

    readonly #decode = async (body: string, peer: Sender): Promise<Received<TInbound> | null> => {
        let raw: unknown;
        try {
            raw = parseJson(body);
        } catch {
            return null;
        }
        const envelope = v.safeParse(envelopeSchema, raw);
        if (
            !envelope.success ||
            envelope.output.sender !== peer ||
            envelope.output.requestId !== this.#binding.requestId ||
            envelope.output.runId !== this.#binding.runId
        ) {
            return null;
        }
        const { nonce, data, ...header } = envelope.output;
        const text = await open(this.#keys.receive, header, { nonce, data });
        if (text === null) {
            return null;
        }
        // An authentic message that breaks the protocol is a fault of the peer, not noise.
        const message = v.safeParse(this.#inbound, { kind: header.kind, body: parseJson(text) });
        if (!message.success) {
            throw new AppError("invalid_response");
        }
        return { ...message.output, sequence: header.sequence };
    };

    /** Continues numbering after this side's earlier messages, for example after a browser reload. */
    readonly #ensureSequence = async (signal: AbortSignal): Promise<void> => {
        if (this.#sequence > 0) {
            return;
        }
        for (const comment of await this.#github.comments(this.#binding.repository, this.#binding.issue, signal)) {
            const envelope = v.safeParse(envelopeSchema, safeJson(comment.body));
            if (
                envelope.success &&
                envelope.output.sender === this.#self &&
                envelope.output.requestId === this.#binding.requestId &&
                envelope.output.runId === this.#binding.runId
            ) {
                const { nonce, data, ...header } = envelope.output;
                if ((await open(this.#keys.send, header, { nonce, data })) !== null) {
                    this.#sequence = Math.max(this.#sequence, header.sequence);
                }
            }
        }
    };
}

function safeJson(text: string): unknown {
    try {
        return parseJson(text);
    } catch {
        return null;
    }
}

function kindOf<TSchema extends MessageSchema>(kind: Kind<TSchema>): EnvelopeHeader["kind"] {
    const parsed = v.safeParse(envelopeSchema.entries.kind, kind);
    if (!parsed.success) {
        throw new AppError("invalid_input");
    }
    return parsed.output;
}
