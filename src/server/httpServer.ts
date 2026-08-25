import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  InMemoryServerEventBus,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
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
  let openListenStreams = 0;

  const innerBus = new InMemoryServerEventBus((error) => log(`[server/error] ${error.message}`));
  // subscriptions/listen が開いた stream ごとに bus へ listener が登録される。
  // 2026-07-28 に resources/subscribe RPC は無いため、この登録が「クライアントが
  // 通知を待ち始めた」ことを server 側から観測できる唯一の点になる。
  const bus: ServerEventBus = {
    publish: (event: ServerEvent) => innerBus.publish(event),
    subscribe: (listener: (event: ServerEvent) => void) => {
      const unsubscribe = innerBus.subscribe(listener);
      let released = false;

      if (++openListenStreams === 1) {
        scheduleUpdate();
      }

      return () => {
        if (!released) {
          released = true;
          if (--openListenStreams === 0) {
            clearUpdateTimer();
          }
        }
        unsubscribe();
      };
    },
  };

  const handler = createMcpHandler(() => createProbeServer({ config, store, log, onResourceRead: startCycle }), {
    legacy: "reject",
    bus,
    onerror: (error) => log(`[server/error] ${error.message}`),
  });

  function clearUpdateTimer(): void {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
    }
  }

  /**
   * listen stream が 1 本も開いていない状態の read = 新しい購読サイクルの initial read。
   * ここで初期状態へ戻さないと、前サイクルで version 2 になった store がそのまま残り、
   * 同じサーバープロセスに対する 2 回目以降の probe が更新を観測できなくなる。
   */
  function startCycle(): void {
    if (openListenStreams === 0) {
      store.reset();
    }
  }

  function scheduleUpdate(): void {
    clearUpdateTimer();

    // 起点は stream の開通。read を起点にすると、通知の発行時点でまだ stream が
    // 開いておらず通知が失われうる（InMemoryServerEventBus はバッファせず、その
    // 時点の listener にのみ同期配信する）。
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
      clearUpdateTimer();
      await handler.close();
    },
  };
}
