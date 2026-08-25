import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";
import type { TestConfig } from "./config.js";
import type { LogSink } from "./logger.js";
import { createProbeServer } from "./mcpServer.js";
import { REVIEW_STATUS_URI, ReviewStatusStore } from "./resourceState.js";

export interface ProbeHttpApp {
  app: express.Express;
  /** subscriptions/listen で開いている stream と保留中の更新タイマーを畳む。 */
  close(): Promise<void>;
}

export function createMcpHttpApp(config: TestConfig, log: LogSink = () => undefined): ProbeHttpApp {
  const app = express();
  // 2026-07-28 では McpServer をリクエストごとに作り直すため、resource の状態と
  // 更新シミュレーションは handler の外（アプリのスコープ）に置く。
  const store = new ReviewStatusStore(config);
  let updateTimer: NodeJS.Timeout | undefined;

  const handler = createMcpHandler(() => createProbeServer({ config, store, log, onResourceRead: scheduleUpdate }), {
    legacy: "reject",
    onerror: (error) => log(`[server/error] ${error.message}`),
  });

  function scheduleUpdate(): void {
    if (updateTimer || store.get().version >= 2) {
      return;
    }

    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      const state = store.markUpdated();
      log(`[resource/update] uri=${REVIEW_STATUS_URI} version=${state.version}`);
      log(`[notification/send] notifications/resources/updated uri=${REVIEW_STATUS_URI}`);
      handler.notify.resourceUpdated(REVIEW_STATUS_URI);

      if (config.sendListChanged) {
        log("[notification/send] notifications/resources/list_changed");
        handler.notify.resourcesChanged();
      }
    }, config.updateDelaySeconds * 1000);
    // 更新待ちのタイマーだけでプロセスを生かし続けない（HTTP サーバーが event loop を保持する）。
    updateTimer.unref();
  }

  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => log(`[server/error] ${error.message}`),
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Serve at /mcp and, if a different gateway path is configured, also at that path.
  const mcpPaths = Array.from(new Set(["/mcp", config.mcpPath]));

  // body parser は挟まない。toNodeHandler は Node の生ストリームから body を読む。
  app.all(mcpPaths, (req: Request, res: Response) => {
    // subscriptions/listen の long-lived SSE stream を、間に立つリバースプロキシ
    // （mcp-gateway 等）にバッファリングさせないための推奨ヘッダー。
    res.setHeader("X-Accel-Buffering", "no");
    void nodeHandler(req, res);
  });

  return {
    app,
    close: async () => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      await handler.close();
    },
  };
}
