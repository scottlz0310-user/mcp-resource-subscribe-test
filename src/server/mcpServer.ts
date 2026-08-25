import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TestConfig } from "./config.js";
import type { LogSink } from "./logger.js";
import {
  REVIEW_STATUS_MIME_TYPE,
  REVIEW_STATUS_RESOURCE,
  REVIEW_STATUS_URI,
  type ReviewStatusStore,
  renderReviewStatus,
} from "./resourceState.js";

export interface ProbeServerDeps {
  config: TestConfig;
  /** リクエスト間で共有される状態。McpServer は 2026-07-28 ではリクエストごとに作り直されるため、ここに置けない。 */
  store: ReviewStatusStore;
  log?: LogSink;
  /** resources/read を受けたときに呼ばれる。購読サイクル境界の判定に使う。 */
  onResourceRead?: (uri: string) => void;
}

function assertReviewStatusUri(uri: string): void {
  if (uri !== REVIEW_STATUS_URI) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
  }
}

export function createProbeServer(deps: ProbeServerDeps): McpServer {
  const { config, store } = deps;
  const log: LogSink = deps.log ?? (() => undefined);

  const server = new McpServer(
    {
      name: "mcp-resource-subscribe-test",
      version: "0.5.0",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: config.sendListChanged,
        },
      },
    },
  );

  server.registerTool(
    "get_review_status",
    {
      description: `Returns the current review status. Same data as reading the ${REVIEW_STATUS_URI} resource.`,
      inputSchema: z.object({}),
    },
    async () => {
      const state = store.get();
      log("[tools/call] get_review_status");
      return {
        content: [{ type: "text", text: renderReviewStatus(state) }],
      };
    },
  );

  server.registerTool(
    "echo_tool",
    {
      description:
        "Testing utility: echoes back the given message as text content. Pass shouldError: true to simulate a tool-level failure (isError: true), for exercising client-side `call` error handling.",
      inputSchema: z.object({
        message: z.string().optional(),
        shouldError: z.boolean().optional(),
      }),
    },
    async (input) => {
      log(`[tools/call] echo_tool ${JSON.stringify(input)}`);
      return {
        content: [{ type: "text", text: input.message ?? "" }],
        isError: input.shouldError === true,
      };
    },
  );

  server.server.setRequestHandler("resources/list", async () => {
    log("[resources/list] requested");
    return {
      resources: [REVIEW_STATUS_RESOURCE],
    };
  });

  server.server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;
    assertReviewStatusUri(uri);

    // 状態を読む前に通知する。購読サイクル先頭での初期状態リセットをこの応答へ反映させるため。
    deps.onResourceRead?.(uri);
    const state = store.get();
    log(`[resources/read] uri=${uri} version=${state.version}`);

    return {
      contents: [
        {
          uri,
          mimeType: REVIEW_STATUS_MIME_TYPE,
          text: renderReviewStatus(state),
        },
      ],
    };
  });

  return server;
}
