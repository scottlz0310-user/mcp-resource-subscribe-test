import { configFromEnv } from "./config.js";
import { createMcpHttpApp } from "./httpServer.js";
import { createConsoleLogger } from "./logger.js";

const config = configFromEnv();
const log = createConsoleLogger(config);
const { app, close } = createMcpHttpApp(config, log);

const httpServer = app.listen(config.port, "0.0.0.0", () => {
  log(`MCP resource subscribe test server listening on http://127.0.0.1:${config.port}/mcp`);
});

const shutdown = () => {
  void close().finally(() => {
    httpServer.close(() => {
      process.exit(0);
    });
    // subscriptions/listen の SSE ストリームなど生存中の接続が残っていると close() は
    // 完了しない（シグナルハンドラ登録済みのため 2 度目の SIGINT でも終了できない）。
    // テストサーバーに graceful drain は不要なので即座に全接続を切断する。
    httpServer.closeAllConnections();
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
