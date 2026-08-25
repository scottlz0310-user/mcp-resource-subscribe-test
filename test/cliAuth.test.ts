import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTokenStore, type StoredToken } from "../src/client/auth/tokenStore.js";
import type { JsonOutput } from "../src/client/jsonOutput.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";
import { type MockAuthServer, startMockAuthServer } from "./helpers/mockAuthServer.js";

const CLI_SRC = join(process.cwd(), "src", "client", "cli.ts");
const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<ExecResult> {
  const childEnv = {
    ...process.env,
    // Isolate from any auth configuration present in the developer's shell.
    MCP_PROBE_AUTH_TOKEN: undefined,
    MCP_PROBE_URL: undefined,
    MCP_PROBE_URI: undefined,
    MCP_PROBE_TOKEN_STORE_PATH: undefined,
    ...env,
  };
  try {
    const { stdout, stderr } = await execFileAsync("node", ["--import", "tsx/esm", CLI_SRC, ...args], {
      encoding: "utf8",
      env: childEnv,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

/** MCP test server that records the Authorization header of every request. */
async function startCapturingMcpServer(): Promise<{
  url: string;
  captured: (string | undefined)[];
  close: () => Promise<void>;
}> {
  const captured: (string | undefined)[] = [];
  const app = express();
  app.use((req, _res, next) => {
    captured.push(req.headers.authorization);
    next();
  });
  const probe = createMcpHttpApp(
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
  app.use(probe.app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    captured,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("CLI auth integration", () => {
  let dir: string;
  let dbPath: string;
  let authServer: MockAuthServer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mrs-cliauth-"));
    dbPath = join(dir, "tokens.db");
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await authServer?.close();
    authServer = null;
  });

  const seedToken = (origin: string, overrides: Partial<StoredToken> = {}): void => {
    const store = openTokenStore(dbPath);
    try {
      store.save({
        origin,
        clientId: "client-1",
        accessToken: "at-cached",
        refreshToken: "rt-cached",
        expiresAt: Date.now() + 60 * 60 * 1000,
        ...overrides,
      });
    } finally {
      store.close();
    }
  };

  it("--login completes the device flow and caches the token set", async () => {
    authServer = await startMockAuthServer({ pendingPolls: 1 });
    const result = await runCli(["--login", "--url", `${authServer.origin}/mcp/subscribe-probe`], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user-code ABCD-1234");
    expect(result.stdout).toContain(`verification-uri-complete ${authServer.origin}/activate?user_code=ABCD-1234`);
    expect(result.stdout).toContain("login-status success");
    expect(result.stdout).toContain(`token-origin ${authServer.origin}`);
    // The token value itself must never be printed.
    expect(result.stdout).not.toContain(authServer.issuedAccessTokens[0]);

    const store = openTokenStore(dbPath);
    try {
      const cached = store.get(authServer.origin);
      expect(cached?.accessToken).toBe(authServer.issuedAccessTokens[0]);
      expect(cached?.refreshToken).not.toBeNull();
    } finally {
      store.close();
    }
  }, 15_000);

  it("--login without a URL fails with SERVER_URL_UNKNOWN", async () => {
    const result = await runCli(["--login"], { MCP_PROBE_TOKEN_STORE_PATH: dbPath });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("login-status failed");
    expect(result.stdout).toContain("error-code SERVER_URL_UNKNOWN");
  });

  it("--logout without a URL fails with SERVER_URL_UNKNOWN", async () => {
    const result = await runCli(["--logout"], { MCP_PROBE_TOKEN_STORE_PATH: dbPath });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("logout-status failed");
    expect(result.stdout).toContain("error-code SERVER_URL_UNKNOWN");
  });

  it("--logout removes the cached token for the given origin", async () => {
    const origin = "http://127.0.0.1:1";
    seedToken(origin);
    const result = await runCli(["--logout", "--url", `${origin}/mcp`], { MCP_PROBE_TOKEN_STORE_PATH: dbPath });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("logout-status success");
    const store = openTokenStore(dbPath);
    try {
      expect(store.get(origin)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("--logout is a no-op when nothing is cached yet", async () => {
    const result = await runCli(["--logout", "--url", "http://127.0.0.1:1/mcp"], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("logout-status success");
  });

  it("--logout with an invalid URL fails structured instead of crashing (no store yet)", async () => {
    const result = await runCli(["--logout", "--url", "not-a-url"], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("logout-status failed");
    expect(result.stdout).toContain("error-code INVALID_URL");
  });

  it("--logout with an invalid URL fails structured instead of crashing (store exists)", async () => {
    seedToken("http://127.0.0.1:1");
    const result = await runCli(["--logout", "--url", "not-a-url"], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("logout-status failed");
    expect(result.stdout).toContain("error-code INVALID_URL");
  });

  it("uses the cached token as Bearer for the probe connection", async () => {
    const mcp = await startCapturingMcpServer();
    try {
      const origin = new URL(mcp.url).origin;
      seedToken(origin);
      const result = await runCli(["--url", mcp.url, "--json", "--timeout-ms", "3000"], {
        MCP_PROBE_TOKEN_STORE_PATH: dbPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("auth token source: cache");
      expect(mcp.captured.length).toBeGreaterThan(0);
      expect(mcp.captured.every((h) => h === "Bearer at-cached")).toBe(true);
    } finally {
      await mcp.close();
    }
  }, 15_000);

  it("prefers an explicit MCP_PROBE_AUTH_TOKEN over the cache", async () => {
    const mcp = await startCapturingMcpServer();
    try {
      const origin = new URL(mcp.url).origin;
      seedToken(origin);
      const result = await runCli(["--url", mcp.url, "--json", "--timeout-ms", "3000"], {
        MCP_PROBE_TOKEN_STORE_PATH: dbPath,
        MCP_PROBE_AUTH_TOKEN: "explicit-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("auth token source");
      expect(mcp.captured.every((h) => h === "Bearer explicit-token")).toBe(true);
    } finally {
      await mcp.close();
    }
  }, 15_000);

  it("connects without Authorization when nothing is cached (backward compatible)", async () => {
    const mcp = await startCapturingMcpServer();
    try {
      const result = await runCli(["--url", mcp.url, "--json", "--timeout-ms", "3000"], {
        MCP_PROBE_TOKEN_STORE_PATH: dbPath,
      });

      expect(result.exitCode).toBe(0);
      expect(mcp.captured.every((h) => h === undefined)).toBe(true);
    } finally {
      await mcp.close();
    }
  }, 15_000);

  // The unattended-refresh success path is covered in gatewayAuth.test.ts
  // (the mock AS and the probed origin must coincide there); at the CLI level
  // we verify the failure path reaches the documented error code.
  it("AUTH_LOGIN_REQUIRED (JSON mode) when the cached token is expired and refresh is rejected", async () => {
    authServer = await startMockAuthServer();
    seedToken(authServer.origin, { expiresAt: Date.now() - 1000, refreshToken: "rt-dead" });
    const result = await runCli(["--url", `${authServer.origin}/mcp`, "--json", "--timeout-ms", "3000"], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout) as JsonOutput;
    expect(json.errorCode).toBe("AUTH_LOGIN_REQUIRED");
    expect(result.stderr).toContain("--login");
  }, 15_000);

  it("AUTH_LOGIN_REQUIRED in line-based mode when refresh is rejected", async () => {
    authServer = await startMockAuthServer();
    seedToken(authServer.origin, { expiresAt: Date.now() - 1000, refreshToken: "rt-dead" });
    const url = `${authServer.origin}/mcp`;
    const result = await runCli(["--url", url, "--timeout-ms", "3000"], {
      MCP_PROBE_TOKEN_STORE_PATH: dbPath,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("error-code AUTH_LOGIN_REQUIRED");
    expect(result.stderr).toContain("run `mcp-resource-subscriber --login");
    // The failure phase-summary must report the actual url/uri, not "unknown",
    // so automation can correlate the failure with the run that produced it.
    expect(result.stdout).toContain(
      `phase-summary route=failed url=${url} uri=test://review/status error-code=AUTH_LOGIN_REQUIRED`,
    );
  }, 15_000);

  it("AUTH_TIMEOUT when the gateway accepts the connection but never responds", async () => {
    // A raw HTTP server that never writes a response, simulating a gateway
    // that accepts the TCP connection but hangs indefinitely.
    const hangingServer = createServer(() => {});
    hangingServer.listen(0, "127.0.0.1");
    await once(hangingServer, "listening");
    const { port } = hangingServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    try {
      seedToken(origin, { expiresAt: Date.now() - 1000 });
      const result = await runCli(["--url", `${origin}/mcp`, "--json", "--timeout-ms", "500"], {
        MCP_PROBE_TOKEN_STORE_PATH: dbPath,
      });

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout) as JsonOutput;
      expect(json.errorCode).toBe("AUTH_TIMEOUT");
    } finally {
      await new Promise<void>((resolve, reject) => hangingServer.close((err) => (err ? reject(err) : resolve())));
    }
  }, 15_000);
});
