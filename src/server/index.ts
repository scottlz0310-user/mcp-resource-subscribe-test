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
  httpServer.close();
  // subscriptions/listen の SSE ストリームなど生存中の接続が残っていると close() も
  // httpServer.close() も完了しない（シグナルハンドラ登録済みのため 2 度目の SIGINT でも
  // 終了できない）。テストサーバーに graceful drain は不要なので、待つ前に全接続を切断する。
  httpServer.closeAllConnections();
  void close().finally(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
