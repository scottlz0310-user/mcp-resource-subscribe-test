import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { openTokenStore, type StoredToken } from "../src/client/auth/tokenStore.js";
import type { CallJsonOutput } from "../src/client/callJsonOutput.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";
import { startMockAuthServer } from "./helpers/mockAuthServer.js";

// Run the TypeScript source directly via tsx so this test suite works on a fresh
// checkout without a prior `pnpm run build` step.
const CLI_SRC = join(process.cwd(), "src", "client", "cli.ts");
const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", ["--import", "tsx/esm", CLI_SRC, "call", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        // Point at a non-existent store so these tests never touch (or create)
        // the developer's real login cache.
        MCP_PROBE_TOKEN_STORE_PATH: join(tmpdir(), "mrs-call-test-absent", "tokens.db"),
        MCP_PROBE_AUTH_TOKEN: undefined,
        MCP_PROBE_URL: undefined,
        ...env,
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { app, close: closeHandler } = createMcpHttpApp(
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
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  const close = async (): Promise<void> => {
    await closeHandler();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  };
  return { url, close };
}

// Port 1 is on undici's forbidden-port list ("bad port"), which fetch() rejects
// before ever attempting a TCP connection — it can't produce ECONNREFUSED. Bind
// an ephemeral port and close it immediately: nothing listens there afterwards,
// so connecting to it reliably reproduces a real connection-refused error.
async function getClosedPortUrl(): Promise<string> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return `http://127.0.0.1:${port}/mcp`;
}

describe("call subcommand: argument parsing", () => {
  it("missing --url fails with SERVER_URL_UNKNOWN, exit code 3", async () => {
    const result = await runCli(["--tool", "echo_tool", "--json"]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("SERVER_URL_UNKNOWN");
    expect(json.tool).toBe("echo_tool");
  });

  it("missing --tool fails with TOOL_NAME_REQUIRED, exit code 3", async () => {
    const result = await runCli(["--url", "http://127.0.0.1:1/mcp", "--json"]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("TOOL_NAME_REQUIRED");
    expect(json.serverUrl).toBe("http://127.0.0.1:1/mcp");
  });

  it("invalid --args JSON fails with INVALID_ARGS, exit code 3", async () => {
    const result = await runCli([
      "--url",
      "http://127.0.0.1:1/mcp",
      "--tool",
      "echo_tool",
      "--args",
      "not-json",
      "--json",
    ]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("INVALID_ARGS");
  });

  it("--args as a JSON array fails with INVALID_ARGS", async () => {
    const result = await runCli([
      "--url",
      "http://127.0.0.1:1/mcp",
      "--tool",
      "echo_tool",
      "--args",
      "[1,2]",
      "--json",
    ]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("INVALID_ARGS");
  });

  it("invalid --timeout-ms fails with INTERNAL_ERROR, exit code 3, no stack trace on stdout", async () => {
    const result = await runCli([
      "--url",
      "http://127.0.0.1:1/mcp",
      "--tool",
      "echo_tool",
      "--timeout-ms",
      "bad",
      "--json",
    ]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("INTERNAL_ERROR");
    expect(result.stdout).not.toContain("at ");
  });

  it("line-based mode (no --json) does not emit JSON on usage error", async () => {
    const result = await runCli(["--tool", "echo_tool"]);

    expect(result.exitCode).toBe(3);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain("error-code SERVER_URL_UNKNOWN");
  });
});

describe("call subcommand: success", () => {
  it("--json: calls echo_tool and returns its content with exit code 0", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--tool", "echo_tool", "--args", '{"message":"hello"}', "--json"]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.isError).toBe(false);
      expect(json.errorCode).toBeNull();
      expect(json.tool).toBe("echo_tool");
      expect(json.serverUrl).toBe(url);
      expect(JSON.stringify(json.content)).toContain("hello");
    } finally {
      await close();
    }
  }, 10_000);

  it("line-based mode: prints server-url/tool/is-error/error-code/recommended-next-action/content lines", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--tool", "echo_tool", "--args", '{"message":"hi-there"}']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`server-url ${url}`);
      expect(result.stdout).toContain("tool echo_tool");
      expect(result.stdout).toContain("is-error false");
      expect(result.stdout).toContain("error-code null");
      expect(result.stdout).toContain("recommended-next-action null");
      expect(result.stdout).toContain("hi-there");
    } finally {
      await close();
    }
  }, 10_000);

  it("defaults --args to {} when omitted", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--tool", "echo_tool", "--json"]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.isError).toBe(false);
    } finally {
      await close();
    }
  }, 10_000);
});

describe("call subcommand: tool error", () => {
  it("--json: echo_tool with shouldError:true returns isError true, exit code 1", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli([
        "--url",
        url,
        "--tool",
        "echo_tool",
        "--args",
        '{"message":"boom","shouldError":true}',
        "--json",
      ]);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.isError).toBe(true);
      expect(json.errorCode).toBe("TOOL_ERROR");
      expect(JSON.stringify(json.content)).toContain("boom");
    } finally {
      await close();
    }
  }, 10_000);

  it("line-based mode: is-error true, error-code TOOL_ERROR, recommended-next-action null", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--tool", "echo_tool", "--args", '{"shouldError":true}']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("is-error true");
      expect(result.stdout).toContain("error-code TOOL_ERROR");
      expect(result.stdout).toContain("recommended-next-action null");
    } finally {
      await close();
    }
  }, 10_000);
});

describe("call subcommand: communication error", () => {
  it("unreachable server (connection refused) fails with CONNECTION_REFUSED, exit code 3", async () => {
    const url = await getClosedPortUrl();
    const result = await runCli(["--url", url, "--tool", "echo_tool", "--json", "--timeout-ms", "2000"]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("CONNECTION_REFUSED");
    expect(json.recommendedNextAction).toContain("--url");
  }, 10_000);

  it("line-based mode: communication error prints the same field set as success/tool-error", async () => {
    const url = await getClosedPortUrl();
    const result = await runCli(["--url", url, "--tool", "echo_tool", "--timeout-ms", "2000"]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain(`server-url ${url}`);
    expect(result.stdout).toContain("tool echo_tool");
    expect(result.stdout).toContain("is-error true");
    expect(result.stdout).toContain("error-code CONNECTION_REFUSED");
    expect(result.stdout).toContain("recommended-next-action The server refused the connection");
    expect(result.stdout).toContain("content");
  }, 10_000);

  it("unresolvable hostname fails with DNS_LOOKUP_FAILED, exit code 3", async () => {
    const result = await runCli([
      "--url",
      "http://this-host-does-not-exist.invalid/mcp",
      "--tool",
      "echo_tool",
      "--json",
      "--timeout-ms",
      "5000",
    ]);

    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout) as CallJsonOutput;
    expect(json.errorCode).toBe("DNS_LOOKUP_FAILED");
    expect(json.recommendedNextAction).toContain("hostname");
  }, 10_000);

  // Regression test for a bug where --timeout-ms only bounded callTool(), not
  // the preceding connect()/initialize request, which used the SDK's default
  // 60s request timeout. A server that accepts the TCP connection but never
  // responds must fail within roughly --timeout-ms, not 60s.
  it("server that accepts the connection but never responds to initialize fails within --timeout-ms (wall clock)", async () => {
    const hangingServer = createServer(() => {});
    hangingServer.listen(0, "127.0.0.1");
    await once(hangingServer, "listening");
    const { port } = hangingServer.address() as AddressInfo;
    try {
      const start = Date.now();
      const result = await runCli([
        "--url",
        `http://127.0.0.1:${port}/mcp`,
        "--tool",
        "echo_tool",
        "--json",
        "--timeout-ms",
        "500",
      ]);
      const elapsedMs = Date.now() - start;

      expect(result.exitCode).toBe(3);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.errorCode).toBe("CALL_FAILED");
      // Generous upper bound (well under the SDK's 60s default) to absorb
      // process spawn/CLI overhead while still proving the fix took effect.
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      await new Promise<void>((resolve, reject) => hangingServer.close((err) => (err ? reject(err) : resolve())));
    }
  }, 15_000);

  // The MCP SDK's server-side tools/call handler catches "tool not found"
  // internally and reports it as a normal CallToolResult with isError: true
  // (not a JSON-RPC protocol error), so this surfaces as TOOL_ERROR/exit 1
  // rather than a communication failure.
  // 2026-07-28 の SDK では不明な tool 名は tools/call の拒否（-32602）として返る。
  // tool 実行そのものの失敗（isError / TOOL_ERROR / exit 1）とは別物として扱う。
  it("unknown tool name surfaces as a rejected request (TOOL_REQUEST_REJECTED), exit code 3", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--tool", "does_not_exist", "--json", "--timeout-ms", "3000"]);

      expect(result.exitCode).toBe(3);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.errorCode).toBe("TOOL_REQUEST_REJECTED");
      expect(json.isError).toBe(true);
      expect(json.recommendedNextAction).toContain("--tool");
    } finally {
      await close();
    }
  }, 10_000);
});

describe("call subcommand: auth error", () => {
  it("AUTH_LOGIN_REQUIRED (JSON mode) when the cached token is expired and refresh is rejected", async () => {
    const authServer = await startMockAuthServer();
    const dbPath = join(tmpdir(), `mrs-call-auth-${Date.now()}`, "tokens.db");
    try {
      const store = openTokenStore(dbPath);
      try {
        const seed: StoredToken = {
          origin: authServer.origin,
          clientId: "client-1",
          accessToken: "at-cached",
          refreshToken: "rt-dead",
          expiresAt: Date.now() - 1000,
        };
        store.save(seed);
      } finally {
        store.close();
      }

      const result = await runCli(
        ["--url", `${authServer.origin}/mcp`, "--tool", "echo_tool", "--json", "--timeout-ms", "3000"],
        { MCP_PROBE_TOKEN_STORE_PATH: dbPath },
      );

      expect(result.exitCode).toBe(2);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.errorCode).toBe("AUTH_LOGIN_REQUIRED");
      expect(result.stderr).toContain("--login");
    } finally {
      await authServer.close();
    }
  }, 15_000);

  it("AUTH_TIMEOUT when the gateway accepts the connection but never responds", async () => {
    const hangingServer = createServer(() => {});
    hangingServer.listen(0, "127.0.0.1");
    await once(hangingServer, "listening");
    const { port } = hangingServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = join(tmpdir(), `mrs-call-authtimeout-${Date.now()}`, "tokens.db");
    try {
      const store = openTokenStore(dbPath);
      try {
        store.save({
          origin,
          clientId: "client-1",
          accessToken: "at-cached",
          refreshToken: "rt-cached",
          expiresAt: Date.now() - 1000,
        });
      } finally {
        store.close();
      }

      const result = await runCli(["--url", `${origin}/mcp`, "--tool", "echo_tool", "--json", "--timeout-ms", "500"], {
        MCP_PROBE_TOKEN_STORE_PATH: dbPath,
      });

      expect(result.exitCode).toBe(2);
      const json = JSON.parse(result.stdout) as CallJsonOutput;
      expect(json.errorCode).toBe("AUTH_TIMEOUT");
    } finally {
      await new Promise<void>((resolve, reject) => hangingServer.close((err) => (err ? reject(err) : resolve())));
    }
  }, 15_000);
});
