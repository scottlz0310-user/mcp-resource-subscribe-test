import type { Client, ConnectOptions, Transport } from "@modelcontextprotocol/client";
import { SdkError, SdkErrorCode, UnsupportedProtocolVersionError } from "@modelcontextprotocol/client";
import { classifyNetworkError } from "./networkErrorClassification.js";

/**
 * The only protocol revision this client speaks. `subscriptions/listen` exists
 * from 2026-07-28 onward, and the migration policy keeps no legacy path: a
 * server that cannot offer this revision must fail loudly rather than silently
 * fall back to `resources/subscribe`.
 */
export const PINNED_PROTOCOL_VERSION = "2026-07-28";

export const PROTOCOL_UNSUPPORTED_HINT =
  `The server does not offer MCP protocol revision ${PINNED_PROTOCOL_VERSION}. ` +
  "This client speaks only that revision; upgrade the server (or the gateway in front of it) before retrying.";

/** Raised when the server cannot serve {@link PINNED_PROTOCOL_VERSION}. */
export class ProtocolNegotiationError extends Error {
  constructor(cause: unknown) {
    super(`MCP protocol negotiation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ProtocolNegotiationError";
  }
}

/** Client options pinning negotiation to {@link PINNED_PROTOCOL_VERSION}. */
export const PINNED_CLIENT_OPTIONS = {
  versionNegotiation: { mode: { pin: PINNED_PROTOCOL_VERSION } },
} as const;

/**
 * Connects with the pinned revision, translating the two ways a pre-2026-07-28
 * server refuses the `server/discover` probe into one error the CLI can report
 * as PROTOCOL_UNSUPPORTED. Auth and transport failures propagate untouched so
 * they keep their own error codes.
 */
export async function connectPinned(client: Client, transport: Transport, options?: ConnectOptions): Promise<void> {
  try {
    await client.connect(transport, options);
  } catch (error) {
    // 到達自体に失敗した場合（DNS / connection refused / TLS）は negotiation の
    // 問題ではない。SDK はこれも ERA_NEGOTIATION_FAILED として包むため、
    // ネットワーク起因を先に除外しないと本来の診断を潰してしまう。
    if (classifyNetworkError(error) !== null) {
      throw error;
    }
    // 未移行のサーバーは server/discover 自体を知らないため、SDK は -32022 ではなく
    // ERA_NEGOTIATION_FAILED を投げる。どちらも「この revision を出せない」の意。
    if (
      error instanceof UnsupportedProtocolVersionError ||
      (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed)
    ) {
      throw new ProtocolNegotiationError(error);
    }
    throw error;
  }
}
