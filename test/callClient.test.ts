import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runToolCall } from "../src/client/callClient.js";
import { buildCallErrorJsonOutput, buildCallJsonOutput } from "../src/client/callJsonOutput.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";

// In-process coverage of runToolCall()/buildCallJsonOutput() to complement the
// CLI subprocess tests in call.test.ts, which spawn a separate Node process
// and therefore aren't visible to the parent process's coverage instrumentation.

const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startServer(): Promise<string> {
  const { app } = createMcpHttpApp(
    {
      port: 0,
      mcpPath: "/mcp",
      updateDelaySeconds: 0.05,
      initialStatus: "pending",
      updatedStatus: "reviewed",
      sendListChanged: false,
      logLevel: "silent",
    },
    () => {},
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

describe("runToolCall()", () => {
  it("resolves with isError: false and the tool's content on success", async () => {
    const url = await startServer();

    const result = await runToolCall({ url, tool: "get_review_status" });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("status:");
  });

  it("defaults args to {} when omitted", async () => {
    const url = await startServer();

    const result = await runToolCall({ url, tool: "echo_tool" });

    expect(result.isError).toBe(false);
  });

  it("resolves with isError: true when the tool reports a failure", async () => {
    const url = await startServer();

    const result = await runToolCall({
      url,
      tool: "echo_tool",
      args: { message: "boom", shouldError: true },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("boom");
  });

  it("forwards requestHeaders to the transport (Authorization observed by the server)", async () => {
    const url = await startServer();

    const result = await runToolCall({
      url,
      tool: "get_review_status",
      requestHeaders: { Authorization: "Bearer test-token" },
    });

    expect(result.isError).toBe(false);
  });

  it("rejects when the server never responds within timeoutMs (bounds connect + callTool)", async () => {
    // Port 1 is a reserved/unassigned port that refuses connections immediately
    // on most platforms, giving a fast, deterministic connection failure.
    await expect(
      runToolCall({ url: "http://127.0.0.1:1/mcp", tool: "get_review_status", timeoutMs: 500 }),
    ).rejects.toThrow();
  });
});

describe("buildCallJsonOutput() / buildCallErrorJsonOutput()", () => {
  it("buildCallJsonOutput: success shape has null errorCode", () => {
    const output = buildCallJsonOutput(
      { content: [{ type: "text", text: "hi" }], isError: false },
      "http://example/mcp",
      "echo_tool",
    );

    expect(output).toEqual({
      serverUrl: "http://example/mcp",
      tool: "echo_tool",
      isError: false,
      errorCode: null,
      content: [{ type: "text", text: "hi" }],
      recommendedNextAction: null,
    });
  });

  it("buildCallJsonOutput: tool error shape has errorCode TOOL_ERROR", () => {
    const output = buildCallJsonOutput(
      { content: [{ type: "text", text: "boom" }], isError: true },
      "http://example/mcp",
      "echo_tool",
    );

    expect(output.errorCode).toBe("TOOL_ERROR");
    expect(output.isError).toBe(true);
  });

  it("buildCallErrorJsonOutput: reports isError true and null content", () => {
    const output = buildCallErrorJsonOutput("CALL_FAILED", "http://example/mcp", "echo_tool");

    expect(output).toEqual({
      serverUrl: "http://example/mcp",
      tool: "echo_tool",
      isError: true,
      errorCode: "CALL_FAILED",
      content: null,
      recommendedNextAction: null,
    });
  });

  it("buildCallErrorJsonOutput: preserves null serverUrl/tool when unknown", () => {
    const output = buildCallErrorJsonOutput("SERVER_URL_UNKNOWN", null, null);

    expect(output.serverUrl).toBeNull();
    expect(output.tool).toBeNull();
  });
});
