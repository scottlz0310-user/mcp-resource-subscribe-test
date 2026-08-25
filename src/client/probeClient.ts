import { Client, type McpSubscription, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connectPinned, PINNED_CLIENT_OPTIONS } from "./protocolNegotiation.js";

// Default URI for the bundled reference server (test://review/status)
const REVIEW_STATUS_URI = "test://review/status";

export interface SubscribeProbeOptions {
  url: string;
  uri?: string;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  /** Extra HTTP headers to include in every request (e.g. Authorization).
   * Keys and values must be valid HTTP header names/values; invalid values
   * will cause the underlying transport to throw at request time.
   */
  requestHeaders?: Record<string, string>;
  /**
   * When true, skip the resources/list check and assume the URI exists.
   * Useful for servers that support dynamic resources not returned by
   * resources/list (e.g. copilot-review-mcp watch URIs).
   */
  skipResourceListCheck?: boolean;
}

export interface SubscribeProbeResult {
  capabilities: unknown;
  resourceFound: boolean;
  initialText: string;
  notificationUri: string;
  finalText: string;
  notificationCount: number;
  /**
   * How the probe completed:
   * - "subscription"     — received notifications/resources/updated, then re-read
   * - "pre-completion"   — post-listen read detected the resource was already
   *                        updated (race: the notification fired before the
   *                        subscription was acknowledged)
   * - "timeout"          — notification never arrived within timeoutMs
   */
  route: "subscription" | "pre-completion" | "timeout";
  /** The server sent notifications/subscriptions/acknowledged for our listen request. */
  listenAcknowledged: boolean;
  /** The resource URIs the server actually honored, taken from the acknowledgement. */
  honoredUris: string[];
  /**
   * How the listen stream ended:
   * - "local"    — this probe closed it (the normal path)
   * - "graceful" — the server ended it deliberately (empty listen response)
   * - "remote"   — the stream dropped without a response (abnormal disconnect)
   */
  closeReason: "local" | "graceful" | "remote" | null;
  errorCode: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RESOURCE_UPDATED_METHOD = "notifications/resources/updated";
const NON_TERMINAL_RECOMMENDED_ACTIONS = new Set(["POLL_AFTER"]);

/** Thrown into a pending notification wait when the listen stream ends first. */
class SubscriptionClosedError extends Error {
  constructor(readonly reason: "local" | "graceful" | "remote") {
    super(`subscriptions/listen stream closed (${reason})`);
    this.name = "SubscriptionClosedError";
  }
}

function getResourceText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0];
  if (!first || !("text" in first)) {
    throw new Error("Expected text resource content");
  }

  return first.text;
}

interface ResourceUpdateEvent {
  sequence: number;
  uri: string;
}

interface ResourceUpdateQueue {
  readonly receivedCount: number;
  readonly lastUri: string;
  readonly waitAfter: (sequence: number, timeoutMs: number) => Promise<ResourceUpdateEvent>;
  /** Rejects any pending wait — used when the listen stream ends before an update arrives. */
  readonly fail: (error: Error) => void;
  readonly cancel: () => void;
}

function createResourceUpdateQueue(client: Client, uri: string): ResourceUpdateQueue {
  const events: ResourceUpdateEvent[] = [];
  let receivedCount = 0;
  let lastUri = "";
  let pending: {
    afterSequence: number;
    resolve: (event: ResourceUpdateEvent) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;

  const findNextEvent = (sequence: number): ResourceUpdateEvent | undefined =>
    events.find((event) => event.sequence > sequence);

  client.setNotificationHandler(RESOURCE_UPDATED_METHOD, (notification) => {
    if (notification.params.uri !== uri) {
      return;
    }

    receivedCount++;
    lastUri = notification.params.uri;
    const event = { sequence: receivedCount, uri: notification.params.uri };
    events.push(event);

    if (events.length > 100) {
      events.shift();
    }

    if (pending && event.sequence > pending.afterSequence) {
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  });

  return {
    get receivedCount(): number {
      return receivedCount;
    },
    get lastUri(): string {
      return lastUri;
    },
    waitAfter: (sequence: number, timeoutMs: number): Promise<ResourceUpdateEvent> => {
      const existing = findNextEvent(sequence);
      if (existing) {
        return Promise.resolve(existing);
      }

      if (timeoutMs <= 0) {
        return Promise.reject(new Error("Timed out waiting for resource update notification"));
      }

      return new Promise<ResourceUpdateEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (pending?.reject === reject) {
            pending = null;
          }
          reject(new Error(`Timed out waiting for resource update notification after ${timeoutMs} ms`));
        }, timeoutMs);

        pending = {
          afterSequence: sequence,
          resolve,
          reject,
          timeout,
        };
      });
    },
    fail: (error: Error) => {
      if (pending) {
        const waiter = pending;
        pending = null;
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    },
    cancel: () => {
      if (pending) {
        clearTimeout(pending.timeout);
        pending = null;
      }
      client.removeNotificationHandler(RESOURCE_UPDATED_METHOD);
    },
  };
}

export function extractRecommendedAction(text: string): string | null {
  const parsed = parseJson(text);
  if (parsed !== null) {
    const fromJson = findRecommendedAction(parsed);
    if (fromJson) {
      return fromJson;
    }
  }

  const match =
    text.match(/(?:^|[\s,{])recommended_next_action\s*[:=]\s*"?([^"\s,}]+)"?/m) ??
    text.match(/"recommended_next_action"\s*:\s*"([^"]+)"/);
  return match ? (match[1] ?? null) : null;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function findRecommendedAction(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.recommended_next_action === "string") {
    return record.recommended_next_action;
  }

  for (const child of Object.values(record)) {
    const action = findRecommendedAction(child);
    if (action) {
      return action;
    }
  }

  return null;
}

function shouldWaitForNextUpdate(text: string): boolean {
  const action = extractRecommendedAction(text);
  return action !== null && NON_TERMINAL_RECOMMENDED_ACTIONS.has(action);
}

/** Maps a failed wait to an error code, distinguishing a dead stream from a quiet one. */
function classifyWaitFailure(error: unknown): string {
  if (error instanceof SubscriptionClosedError) {
    return error.reason === "remote" ? "SUBSCRIPTION_DISCONNECTED" : "SUBSCRIPTION_CLOSED";
  }
  return "NOTIFICATION_TIMEOUT";
}

export async function runSubscribeProbe(options: SubscribeProbeOptions): Promise<SubscribeProbeResult> {
  const uri = options.uri ?? REVIEW_STATUS_URI;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client(
    {
      name: options.clientName ?? "mcp-resource-subscribe-probe-client",
      // 実バージョンは呼び出し元（cli.ts が package.json から解決）が渡す。
      // 未指定のライブラリ利用では、古い実バージョンを騙るよりプレースホルダを名乗る。
      version: options.clientVersion ?? "0.0.0",
    },
    PINNED_CLIENT_OPTIONS,
  );

  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.requestHeaders ? { headers: options.requestHeaders } : undefined,
    });
    await connectPinned(client, transport);

    const capabilities = client.getServerCapabilities()?.resources ?? null;
    let resourceFound: boolean;
    if (options.skipResourceListCheck) {
      resourceFound = true;
    } else {
      const resources = await client.listResources();
      resourceFound = resources.resources.some((resource) => resource.uri === uri);
      if (!resourceFound) {
        return {
          capabilities,
          resourceFound: false,
          initialText: "",
          notificationUri: "",
          finalText: "",
          notificationCount: 0,
          route: "timeout",
          listenAcknowledged: false,
          honoredUris: [],
          closeReason: null,
          errorCode: "RESOURCE_NOT_FOUND",
        };
      }
    }

    const initial = await client.readResource({ uri });
    const initialText = getResourceText(initial);
    const notifications = createResourceUpdateQueue(client, uri);
    let notificationUri = "";
    let notificationSequence = 0;
    let finalText = "";
    let errorCode: string | null = null;
    let route: "subscription" | "pre-completion" | "timeout" = "timeout";
    let closeReason: "local" | "graceful" | "remote" | null = null;
    const deadlineMs = Date.now() + timeoutMs;

    const remainingMs = (): number => Math.max(0, deadlineMs - Date.now());

    let subscription: McpSubscription;
    try {
      subscription = await client.listen({ resourceSubscriptions: [uri] }, { timeout: remainingMs() });
    } catch {
      notifications.cancel();
      return {
        capabilities,
        resourceFound: true,
        initialText,
        notificationUri: "",
        finalText: "",
        notificationCount: 0,
        route: "timeout",
        listenAcknowledged: false,
        honoredUris: [],
        closeReason: null,
        errorCode: "SUBSCRIPTION_FAILED",
      };
    }

    const honoredUris = subscription.honoredFilter.resourceSubscriptions ?? [];
    // 切断は待ち受け中の wait を即座に落とす。応答なしの終了は異常切断であり、
    // timeout まで黙って待ち続けてよいものではない。
    void subscription.closed.then((reason) => {
      closeReason = reason;
      if (reason !== "local") {
        notifications.fail(new SubscriptionClosedError(reason));
      }
    });

    // ack は server が実際に honor した filter のサブセット。要求した URI が
    // 欠けていれば通知は永久に来ないため、待ち続けず明示的なエラーとして返す。
    if (!honoredUris.includes(uri)) {
      await subscription.close().catch(() => undefined);
      notifications.cancel();
      return {
        capabilities,
        resourceFound: true,
        initialText,
        notificationUri: "",
        finalText: "",
        notificationCount: 0,
        route: "timeout",
        listenAcknowledged: true,
        honoredUris,
        closeReason,
        errorCode: "SUBSCRIPTION_NOT_HONORED",
      };
    }

    // Wrap all post-listen operations in a single try/finally so that
    // notifications.cancel() and subscription.close() always run — even when
    // the post-listen read (pre-completion check) or the final read throws.
    try {
      const postListenReadAfterSequence = notifications.receivedCount;
      // Immediately read once after the acknowledgement to handle the
      // pre-completion race condition: if the resource was already updated
      // before our subscription was acknowledged, we will never receive that
      // notification. Comparing with initialText detects this window.
      const postListenText = getResourceText(await client.readResource({ uri }));
      notificationSequence = postListenReadAfterSequence;
      if (postListenText !== initialText) {
        finalText = postListenText;
        if (notifications.receivedCount > postListenReadAfterSequence) {
          route = "subscription";
          notificationUri = notifications.lastUri;
        } else if (!shouldWaitForNextUpdate(finalText)) {
          route = "pre-completion";
        }

        while (shouldWaitForNextUpdate(finalText) && !errorCode) {
          try {
            const event = await notifications.waitAfter(notificationSequence, remainingMs());
            notificationSequence = event.sequence;
            notificationUri = event.uri;
            route = "subscription";
          } catch (error) {
            errorCode = classifyWaitFailure(error);
            break;
          }

          finalText = getResourceText(await client.readResource({ uri }));
        }
      } else {
        try {
          const event = await notifications.waitAfter(notificationSequence, remainingMs());
          notificationSequence = event.sequence;
          notificationUri = event.uri;
          route = "subscription";
        } catch (error) {
          errorCode = classifyWaitFailure(error);
        }

        if (route === "subscription") {
          finalText = getResourceText(await client.readResource({ uri }));
          while (shouldWaitForNextUpdate(finalText) && !errorCode) {
            try {
              const event = await notifications.waitAfter(notificationSequence, remainingMs());
              notificationSequence = event.sequence;
              notificationUri = event.uri;
            } catch (error) {
              errorCode = classifyWaitFailure(error);
              break;
            }

            finalText = getResourceText(await client.readResource({ uri }));
          }
        }
      }
    } finally {
      notifications.cancel();
      // 2026-07-28 に resources/unsubscribe RPC は存在しない。stream を閉じることが解除。
      await subscription.close().catch(() => undefined);
    }

    return {
      capabilities,
      resourceFound: true,
      initialText,
      notificationUri,
      finalText,
      notificationCount: notifications.receivedCount,
      route,
      listenAcknowledged: true,
      honoredUris,
      closeReason,
      errorCode,
    };
  } finally {
    await client.close();
  }
}
