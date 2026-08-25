import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { buildJsonOutput, type JsonOutput } from "../src/client/jsonOutput.js";
import { extractRecommendedAction, runSubscribeProbe } from "../src/client/probeClient.js";
import {
  PINNED_CLIENT_OPTIONS,
  PINNED_PROTOCOL_VERSION,
  ProtocolNegotiationError,
} from "../src/client/protocolNegotiation.js";
import { configFromEnv, type TestConfig } from "../src/server/config.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";
import {
  createInitialReviewStatus,
  createUpdatedReviewStatus,
  REVIEW_STATUS_RESOURCE,
  REVIEW_STATUS_URI,
  renderReviewStatus,
} from "../src/server/resourceState.js";

const TEST_CONFIG: TestConfig = {
  port: 0,
  mcpPath: "/mcp",
  updateDelaySeconds: 0.05,
  initialStatus: "pending",
  updatedStatus: "reviewed",
  sendListChanged: false,
  logLevel: "silent",
};

const servers: Server[] = [];
const clients: Client[] = [];
const closers: Array<() => Promise<void>> = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function listenOn(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

async function startServer(logs: string[], config: TestConfig = TEST_CONFIG): Promise<URL> {
  const { app, close } = createMcpHttpApp(config, (line) => logs.push(line));
  closers.push(close);
  return new URL(await listenOn(createServer(app)));
}

interface StartedHandler {
  url: string;
  handler: McpHttpHandler;
  server: Server;
}

/**
 * Starts a bare 2026-07-28 handler over node:http. Every ad-hoc server in this
 * file goes through here so they exercise the same modern-only serving the
 * reference server uses.
 */
async function startHandler(
  factory: () => McpServer,
  options: { maxSubscriptions?: number } = {},
): Promise<StartedHandler> {
  const handler = createMcpHandler(factory, { legacy: "reject", ...options });
  closers.push(() => handler.close());
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((req, res) => {
    void nodeHandler(req, res);
  });
  return { url: await listenOn(server), handler, server };
}

function connectClient(url: string | URL, name = "test-client"): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" }, PINNED_CLIENT_OPTIONS);
  clients.push(client);
  return client.connect(new StreamableHTTPClientTransport(new URL(url))).then(() => client);
}

function getText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0];
  if (!first || !("text" in first)) {
    throw new Error("Expected text resource content");
  }

  return first.text;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

interface ActionSequenceReadContext {
  readCount: number;
  textIndex: number;
  setTextIndex: (index: number) => void;
  sendUpdate: () => Promise<void>;
}

interface ActionSequenceServerOptions {
  readText?: (context: ActionSequenceReadContext) => string | Promise<string>;
  /** Advertised resources.subscribe capability. false makes the ack drop our URI. */
  subscribeCapability?: boolean;
  maxSubscriptions?: number;
}

/**
 * A server that walks `texts` as the resource body, publishing an update after
 * each entry of `updateDelaysMs`. The timers start on the second read — the
 * probe's post-listen read — so an update can never fire before the
 * subscription has been acknowledged.
 */
async function startActionSequenceServer(
  texts: string[],
  updateDelaysMs: number[],
  options: ActionSequenceServerOptions = {},
): Promise<string> {
  let readCount = 0;
  let textIndex = 0;
  let timersStarted = false;
  let started: StartedHandler | undefined;

  const setTextIndex = (index: number): void => {
    textIndex = index;
  };
  const sendUpdate = async (): Promise<void> => {
    started?.handler.notify.resourceUpdated(REVIEW_STATUS_URI);
  };
  const startTimers = (): void => {
    if (timersStarted) {
      return;
    }
    timersStarted = true;
    for (const [index, delayMs] of updateDelaysMs.entries()) {
      setTimeout(() => {
        setTextIndex(index + 1);
        void sendUpdate();
      }, delayMs).unref();
    }
  };

  started = await startHandler(
    () => {
      const server = new McpServer(
        { name: "test-action-sequence", version: "0.1.0" },
        { capabilities: { resources: { subscribe: options.subscribeCapability ?? true } } },
      );

      server.server.setRequestHandler("resources/list", async () => ({
        resources: [REVIEW_STATUS_RESOURCE],
      }));

      server.server.setRequestHandler("resources/read", async () => {
        readCount++;
        const text = options.readText
          ? await options.readText({ readCount, textIndex, setTextIndex, sendUpdate })
          : (texts[textIndex] ?? "");
        if (readCount >= 2) {
          startTimers();
        }
        return {
          contents: [{ uri: REVIEW_STATUS_URI, mimeType: "text/plain", text }],
        };
      });

      return server;
    },
    options.maxSubscriptions === undefined ? {} : { maxSubscriptions: options.maxSubscriptions },
  );

  return started.url;
}

describe("MCP resource subscription probe", () => {
  it.each([
    ["adds a leading slash", { MCP_TEST_PATH: "custom-mcp" }, "/custom-mcp"],
    ["trims trailing slashes", { MCP_TEST_PATH: "/custom-mcp///" }, "/custom-mcp"],
    ["falls back for blank values", { MCP_TEST_PATH: "   " }, "/mcp"],
  ])("parses MCP_TEST_PATH: %s", (_name, env, expected) => {
    expect(configFromEnv(env).mcpPath).toBe(expected);
  });

  it.each([
    ["key-value text", "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER", "POLL_AFTER"],
    ["inline text", 'final: { review_status: "IN_PROGRESS", recommended_next_action: "POLL_AFTER" }', "POLL_AFTER"],
    ["top-level JSON", JSON.stringify({ recommended_next_action: "READ_REVIEW_THREADS" }), "READ_REVIEW_THREADS"],
    ["nested JSON", JSON.stringify({ watch: { recommended_next_action: "CHECK_FAILURE" } }), "CHECK_FAILURE"],
  ])("extracts recommended_next_action from %s", (_name, text, expected) => {
    expect(extractRecommendedAction(text)).toBe(expected);
  });

  it("exposes get_review_status in tools/list and returns status text on tools/call", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);
    const client = await connectClient(url, "test-tool-client");

    const { tools } = await client.listTools();
    expect(tools).toContainEqual(expect.objectContaining({ name: "get_review_status" }));

    const result = await client.callTool({ name: "get_review_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    expect(texts).toContain("version: 1");
    expect(texts).toContain("status: pending");

    expect(logs).toContain("[tools/call] get_review_status");
  });

  it("lists, reads, listens, acknowledges, notifies, and re-reads the updated resource", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);
    const client = await connectClient(url, "mcp-resource-subscribe-test-client");

    expect(client.getServerCapabilities()?.resources).toEqual({
      subscribe: true,
      listChanged: false,
    });

    const resources = await client.listResources();
    expect(resources.resources).toContainEqual(
      expect.objectContaining({
        uri: REVIEW_STATUS_URI,
        name: "Review Status",
        mimeType: "text/plain",
      }),
    );

    const notified: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      notified.push(notification.params.uri);
    });

    const initial = await client.readResource({ uri: REVIEW_STATUS_URI });
    expect(getText(initial)).toContain("version: 1");
    expect(getText(initial)).toContain("status: pending");

    // 更新シミュレーションは subscriptions/listen の stream 開通を起点にする
    // （2026-07-28 に resources/subscribe RPC は無い）。read だけでは更新は始まらない。
    const subscription = await client.listen({ resourceSubscriptions: [REVIEW_STATUS_URI] });
    expect(subscription.honoredFilter.resourceSubscriptions).toContain(REVIEW_STATUS_URI);

    await expect.poll(() => notified, { timeout: 2_000 }).toContain(REVIEW_STATUS_URI);

    const updated = await client.readResource({ uri: REVIEW_STATUS_URI });
    expect(getText(updated)).toContain("version: 2");
    expect(getText(updated)).toContain("status: reviewed");

    await subscription.close();

    expect(logs).toEqual(
      expect.arrayContaining([
        "[resources/list] requested",
        "[resources/read] uri=test://review/status version=1",
        "[resource/update] uri=test://review/status version=2",
        "[notification/send] notifications/resources/updated uri=test://review/status",
        "[resources/read] uri=test://review/status version=2",
      ]),
    );
  });

  it("runs the reusable subscription probe client flow", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      timeoutMs: 2_000,
    });

    expect(result.capabilities).toEqual({
      subscribe: true,
      listChanged: false,
    });
    expect(result.resourceFound).toBe(true);
    expect(result.initialText).toContain("version: 1");
    expect(result.initialText).toContain("status: pending");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(1);
    expect(result.finalText).toContain("version: 2");
    expect(result.finalText).toContain("status: reviewed");
    expect(result.route).toBe("subscription");
    expect(result.listenAcknowledged).toBe(true);
    expect(result.honoredUris).toEqual([REVIEW_STATUS_URI]);
    expect(result.closeReason).toBe("local");
    expect(result.errorCode).toBeNull();

    expect(logs).toEqual(
      expect.arrayContaining([
        "[notification/send] notifications/resources/updated uri=test://review/status",
        "[resources/read] uri=test://review/status version=2",
      ]),
    );
  });

  it("serves repeated probes against the same server process", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    for (const attempt of [1, 2, 3]) {
      const result = await runSubscribeProbe({ url: url.toString(), timeoutMs: 2_000 });

      expect(result.errorCode, `probe ${attempt}`).toBeNull();
      expect(result.route, `probe ${attempt}`).toBe("subscription");
      expect(result.initialText, `probe ${attempt}`).toContain("version: 1");
      expect(result.finalText, `probe ${attempt}`).toContain("version: 2");
    }
  });

  it("keeps the subscription open while recommended_next_action is POLL_AFTER", async () => {
    const url = await startActionSequenceServer(
      [
        "review_status: PENDING\nrecommended_next_action: POLL_AFTER\nversion: 1",
        "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER\nversion: 2",
        "review_status: COMPLETED\nrecommended_next_action: READ_REVIEW_THREADS\nversion: 3",
      ],
      [20, 40],
    );

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 1_000,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.listenAcknowledged).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(2);
    expect(result.finalText).toContain("review_status: COMPLETED");
    expect(result.finalText).toContain("recommended_next_action: READ_REVIEW_THREADS");
    expect(result.closeReason).toBe("local");
    expect(result.errorCode).toBeNull();
  });

  it("does not skip notifications that arrive while reading after a POLL_AFTER notification", async () => {
    const texts = [
      "review_status: PENDING\nrecommended_next_action: POLL_AFTER\nversion: 1",
      "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER\nversion: 2",
      "review_status: COMPLETED\nrecommended_next_action: READ_REVIEW_THREADS\nversion: 3",
    ];
    const url = await startActionSequenceServer(texts, [20], {
      readText: async ({ readCount, textIndex, setTextIndex, sendUpdate }) => {
        if (readCount === 3) {
          setTimeout(() => {
            void (async () => {
              setTextIndex(2);
              await sendUpdate();
            })().catch(() => undefined);
          }, 10).unref();

          await sleep(30);
          return texts[1] ?? "";
        }

        return texts[textIndex] ?? "";
      },
    });

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 1_000,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.listenAcknowledged).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(2);
    expect(result.finalText).toContain("review_status: COMPLETED");
    expect(result.finalText).toContain("recommended_next_action: READ_REVIEW_THREADS");
    expect(result.errorCode).toBeNull();
  });

  it("runs the probe with skipResourceListCheck bypassing the resources/list call", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      timeoutMs: 2_000,
      skipResourceListCheck: true,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.listenAcknowledged).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.errorCode).toBeNull();
    // Verify the resources/list round-trip was skipped
    expect(logs).not.toContain("[resources/list] requested");
  });

  it("returns RESOURCE_NOT_FOUND errorCode when resource URI does not exist", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      uri: "test://does-not-exist",
      timeoutMs: 2_000,
    });

    expect(result.resourceFound).toBe(false);
    expect(result.errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(result.route).toBe("timeout");
    expect(result.listenAcknowledged).toBe(false);
    expect(result.honoredUris).toEqual([]);
  });

  it("returns NOTIFICATION_TIMEOUT errorCode when server never sends notification", async () => {
    const logs: string[] = [];
    // Use a large updateDelaySeconds so the notification never arrives within the probe timeout
    const url = await startServer(logs, { ...TEST_CONFIG, updateDelaySeconds: 100 });

    const result = await runSubscribeProbe({
      url: url.toString(),
      uri: REVIEW_STATUS_URI,
      timeoutMs: 200,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.errorCode).toBe("NOTIFICATION_TIMEOUT");
    expect(result.route).toBe("timeout");
    expect(result.listenAcknowledged).toBe(true);
    expect(result.closeReason).toBe("local");
  });

  it("returns SUBSCRIPTION_NOT_HONORED when the acknowledgement drops the requested URI", async () => {
    const url = await startActionSequenceServer(["initial-text"], [], { subscribeCapability: false });

    const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 2_000 });

    expect(result.resourceFound).toBe(true);
    expect(result.listenAcknowledged).toBe(true);
    expect(result.honoredUris).not.toContain(REVIEW_STATUS_URI);
    expect(result.errorCode).toBe("SUBSCRIPTION_NOT_HONORED");
    expect(result.route).toBe("timeout");
  });

  it("returns SUBSCRIPTION_FAILED errorCode when the server rejects subscriptions/listen", async () => {
    const url = await startActionSequenceServer(["initial-text"], [], { maxSubscriptions: 0 });

    const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 2_000 });

    expect(result.resourceFound).toBe(true);
    expect(result.errorCode).toBe("SUBSCRIPTION_FAILED");
    expect(result.route).toBe("timeout");
    expect(result.listenAcknowledged).toBe(false);
  });

  it("returns SUBSCRIPTION_DISCONNECTED when the listen stream drops without a response", async () => {
    const logs: string[] = [];
    const { app, close } = createMcpHttpApp({ ...TEST_CONFIG, updateDelaySeconds: 100 }, (line) => logs.push(line));
    closers.push(close);
    const server = createServer(app);
    const url = await listenOn(server);

    const probe = runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 10_000 });
    // 通知待ちに入ってから接続ごと落とす。listen の応答なしに stream が切れるため、
    // client からは異常切断として観測されなければならない。
    await sleep(300);
    server.closeAllConnections();

    const result = await probe;

    expect(result.listenAcknowledged).toBe(true);
    expect(result.errorCode).toBe("SUBSCRIPTION_DISCONNECTED");
    expect(result.closeReason).toBe("remote");
    expect(result.route).toBe("timeout");
  });

  describe("2026-07-28 negotiation", () => {
    it("rejects a pre-2026-07-28 server instead of falling back to resources/subscribe", async () => {
      // server/discover を知らない旧サーバーの最小再現。
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          const id = (JSON.parse(body || "{}") as { id?: unknown }).id ?? null;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
        });
      });
      const url = await listenOn(server);

      await expect(runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 2_000 })).rejects.toBeInstanceOf(
        ProtocolNegotiationError,
      );
    });

    it("rejects a legacy initialize handshake and answers GET with 405", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const legacy = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy-client", version: "0.0.0" },
          },
        }),
      });
      const legacyBody = (await legacy.json()) as { error?: { code: number; data?: { supported?: string[] } } };
      expect(legacyBody.error?.code).toBe(-32022);
      expect(legacyBody.error?.data?.supported).toContain(PINNED_PROTOCOL_VERSION);

      const get = await fetch(url, { method: "GET" });
      expect(get.status).toBe(405);
      // standalone GET SSE は廃止されたため、long-lived stream の抑止ヘッダーだけは残る。
      expect(get.headers.get("x-accel-buffering")).toBe("no");
    });
  });

  describe("--json output mode (buildJsonOutput)", () => {
    it("emits valid JSON shape on successful subscription", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({ url: url.toString(), timeoutMs: 2_000 });
      const output = buildJsonOutput(result, url.toString(), REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("subscription");
      expect(json.serverUrl).toBe(url.toString());
      expect(json.resourceUri).toBe(REVIEW_STATUS_URI);
      expect(json.listenAcknowledged).toBe(true);
      expect(json.honoredUris).toEqual([REVIEW_STATUS_URI]);
      expect(json.notificationReceived).toBe(true);
      expect(json.notificationCount).toBe(1);
      expect(json.closeReason).toBe("local");
      expect(json.errorCode).toBeNull();
      expect(typeof json.initialText).toBe("string");
      expect(typeof json.finalText).toBe("string");
    });

    it("emits valid JSON shape on timeout (failure path)", async () => {
      const url = await startActionSequenceServer(["initial-text"], []);

      const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 100 });
      const output = buildJsonOutput(result, url, REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("timeout");
      expect(json.serverUrl).toBe(url);
      expect(json.resourceUri).toBe(REVIEW_STATUS_URI);
      expect(json.listenAcknowledged).toBe(true);
      expect(json.notificationReceived).toBe(false);
      expect(json.notificationCount).toBe(0);
      expect(json.errorCode).toBe("NOTIFICATION_TIMEOUT");
      expect(json.finalText).toBeNull();
    });

    it("emits valid JSON shape when resource is not found", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({
        url: url.toString(),
        uri: "test://does-not-exist",
        timeoutMs: 1_000,
      });
      const output = buildJsonOutput(result, url.toString(), "test://does-not-exist");
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("timeout");
      expect(json.listenAcknowledged).toBe(false);
      expect(json.notificationReceived).toBe(false);
      expect(json.errorCode).toBe("RESOURCE_NOT_FOUND");
      expect(json.initialText).toBeNull();
      expect(json.finalText).toBeNull();
    });

    it("sets recommendedNextAction from finalText when present", async () => {
      const url = await startActionSequenceServer(
        ["initial", JSON.stringify({ recommended_next_action: "READ_REVIEW_THREADS" })],
        [20],
      );

      const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 1_000 });
      const output = buildJsonOutput(result, url, REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.recommendedNextAction).toBe("READ_REVIEW_THREADS");
    });

    it("stdout JSON is valid (serializes without error and round-trips)", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({ url: url.toString(), timeoutMs: 2_000 });
      const output = buildJsonOutput(result, url.toString(), REVIEW_STATUS_URI);
      const serialized = JSON.stringify(output);

      expect(() => JSON.parse(serialized)).not.toThrow();
      const parsed = JSON.parse(serialized) as JsonOutput;
      expect(Object.keys(parsed)).toEqual([
        "route",
        "serverUrl",
        "resourceUri",
        "listenAcknowledged",
        "honoredUris",
        "notificationReceived",
        "notificationCount",
        "closeReason",
        "errorCode",
        "initialText",
        "finalText",
        "recommendedNextAction",
      ]);
    });
  });

  it("takes the pre-completion route when the resource was already updated before the acknowledgement", async () => {
    // Simulates the race condition: the resource updates between the initial read
    // and the acknowledgement, so the notification fired before our subscription
    // existed. The server returns version 1 on the first read and version 2 on
    // every later read, without ever publishing an update.
    let readCount = 0;
    const { url } = await startHandler(() => {
      const server = new McpServer(
        { name: "test-pre-completed", version: "0.1.0" },
        { capabilities: { resources: { subscribe: true } } },
      );

      server.server.setRequestHandler("resources/list", async () => ({
        resources: [REVIEW_STATUS_RESOURCE],
      }));

      server.server.setRequestHandler("resources/read", async () => {
        readCount++;
        const state = readCount === 1 ? createInitialReviewStatus(TEST_CONFIG) : createUpdatedReviewStatus(TEST_CONFIG);
        return { contents: [{ uri: REVIEW_STATUS_URI, mimeType: "text/plain", text: renderReviewStatus(state) }] };
      });

      return server;
    });

    const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 500 });

    expect(result.resourceFound).toBe(true);
    expect(result.listenAcknowledged).toBe(true);
    expect(result.closeReason).toBe("local");
    expect(result.route).toBe("pre-completion");
    expect(result.initialText).toContain("version: 1");
    expect(result.finalText).toContain("version: 2");
    expect(result.notificationUri).toBe("");
    expect(result.errorCode).toBeNull();
  });
});
