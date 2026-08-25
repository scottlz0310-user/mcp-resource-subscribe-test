#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolError, ProtocolErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { AuthLoginRequiredError, AuthTimeoutError, loginToGateway, resolveCachedToken } from "./auth/gatewayAuth.js";
import { OAuthRequestError } from "./auth/oauthClient.js";
import { openTokenStore, tokenStoreExists } from "./auth/tokenStore.js";
import { runToolCall } from "./callClient.js";
import { buildCallErrorJsonOutput, buildCallJsonOutput } from "./callJsonOutput.js";
import { buildErrorJsonOutput, buildJsonOutput } from "./jsonOutput.js";
import { classifyNetworkError } from "./networkErrorClassification.js";
import { extractRecommendedAction, runSubscribeProbe } from "./probeClient.js";
import { PROTOCOL_UNSUPPORTED_HINT, ProtocolNegotiationError } from "./protocolNegotiation.js";

// Default URI for the bundled reference server
const REVIEW_STATUS_URI = "test://review/status";

const TOOL_REQUEST_REJECTED_HINT =
  "The server rejected the tools/call request before running the tool (unknown tool name or invalid arguments). Check --tool and --args.";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Try compiled path (dist/src/) first, then source path (src/) for tsx direct-run
function readPkg(): { name: string; version: string } {
  for (const rel of ["../../package.json", "../../../package.json", "../package.json"]) {
    try {
      return JSON.parse(readFileSync(resolve(__dirname, rel), "utf8")) as {
        name: string;
        version: string;
      };
    } catch {
      // try next candidate
    }
  }
  return { name: "mcp-resource-subscriber", version: "0.0.0" };
}
const pkg = readPkg();

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (index === -1) {
    return undefined;
  }
  const arg = process.argv[index];
  if (arg.startsWith(prefix)) {
    return arg.slice(prefix.length);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

// Throw-safe variant for best-effort context capture outside the try block.
function peekOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (index === -1) return undefined;
  const arg = process.argv[index];
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log("");
  console.log("Usage:");
  console.log(
    "  mcp-resource-subscriber --url <server-url> [--uri <resource-uri>] [--auth-token <tok>] [--skip-resource-list-check] [--timeout-ms <ms>] [--json]",
  );
  console.log(
    "  mcp-resource-subscriber call --url <server-url> --tool <name> [--args <json>] [--auth-token <tok>] [--timeout-ms <ms>] [--json]",
  );
  console.log("");
  console.log("Call mode (single tools/call invocation, then exit):");
  console.log("  --tool <name>       MCP tool name to invoke (required)");
  console.log("  --args <json>       JSON object of tool arguments (default: {})");
  console.log("  Reuses --url, --auth-token, --login cache, --timeout-ms, --json from below.");
  console.log("  Exit codes: 0 success, 1 tool error (isError), 2 auth error, 3 communication/usage error.");
  console.log("");
  console.log("Options:");
  console.log("  --url <url>         MCP server Streamable HTTP endpoint");
  console.log("                      Env: MCP_PROBE_URL");
  console.log("  --uri <uri>         Resource URI to subscribe to");
  console.log("                      Default: test://review/status (bundled test server only)");
  console.log("                      Env: MCP_PROBE_URI");
  console.log("  --auth-token <tok>  Bearer token for Authorization header");
  console.log("                      Prefer MCP_PROBE_AUTH_TOKEN env var. Command-line flags");
  console.log("                      are visible in process lists and may be stored in shell");
  console.log("                      history. Env: MCP_PROBE_AUTH_TOKEN (recommended)");
  console.log("  --login             Interactive device-flow login (RFC 8628) against the");
  console.log("                      gateway serving --url. Prints a verification URI to");
  console.log("                      approve in a browser, then caches the issued tokens so");
  console.log("                      later runs authenticate and refresh automatically.");
  console.log("                      Explicit --auth-token / MCP_PROBE_AUTH_TOKEN always");
  console.log("                      override the cache. Cache: MCP_PROBE_TOKEN_STORE_PATH");
  console.log("  --logout             Remove the cached token set for the gateway serving");
  console.log("                      --url. Use after a gateway rebuild or DCR store reset");
  console.log("                      so the next --login registers a fresh client.");
  console.log("  --skip-resource-list-check");
  console.log("                      Skip resources/list and assume the URI exists.");
  console.log("                      Use for servers with dynamic resources not in list.");
  console.log("                      Env: MCP_PROBE_SKIP_LIST_CHECK=true");
  console.log("  --timeout-ms <ms>   Notification wait timeout in ms (default: 15000)");
  console.log("                      Env: MCP_PROBE_TIMEOUT_MS");
  console.log("  --json              Emit a single JSON object to stdout instead of line-based output.");
  console.log("                      Diagnostic messages are written to stderr only.");
  console.log("  --version, -v       Print version and exit");
  console.log("  --help, -h          Print this help and exit");
  console.log("");
  console.log("Examples:");
  console.log("  # Against the bundled test server (must be running on :8089):");
  console.log("  mcp-resource-subscriber --url http://127.0.0.1:8089/mcp");
  console.log("");
  console.log("  # Against copilot-review-mcp:");
  console.log("  mcp-resource-subscriber --url http://127.0.0.1:8080/mcp/copilot-review \\");
  console.log("    --uri copilot-review://watch/<watch_id> \\");
  console.log("    --timeout-ms 900000");
  console.log("");
  console.log("  # JSON output mode (for agent workflow integration):");
  console.log("  mcp-resource-subscriber --url http://localhost:3000/mcp \\");
  console.log("    --uri queue://review/re-review-requests \\");
  console.log("    --timeout-ms 900000 \\");
  console.log("    --json");
  console.log("");
  console.log("  # One-time interactive login against an mcp-gateway:");
  console.log("  mcp-resource-subscriber --login --url http://127.0.0.1:8080/mcp/subscribe-probe");
  console.log("");
  console.log("  # Call an MCP tool once and exit (uses the same --login token cache):");
  console.log("  mcp-resource-subscriber call \\");
  console.log("    --url https://gateway.example/mcp/thread-owl \\");
  console.log("    --tool enqueue_review \\");
  console.log('    --args \'{"owner":"scottlz0310","repo":"example","prNumber":123}\' \\');
  console.log("    --json");
  console.log("");
  console.log("  # Remove the cached token set for a gateway (e.g. after it was rebuilt):");
  console.log("  mcp-resource-subscriber --logout --url http://127.0.0.1:8080/mcp/subscribe-probe");
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

if (args.includes("--login")) {
  const loginUrl = peekOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  let loginExitCode = 0;
  if (loginUrl === null) {
    console.error("--login requires --url (or MCP_PROBE_URL) pointing at the gateway MCP endpoint");
    console.log("login-status failed");
    console.log("error-code SERVER_URL_UNKNOWN");
    loginExitCode = 1;
  } else {
    const store = openTokenStore();
    try {
      const result = await loginToGateway(loginUrl, store, (deviceAuth) => {
        console.log(`user-code ${deviceAuth.userCode}`);
        console.log(`verification-uri ${deviceAuth.verificationUri}`);
        if (deviceAuth.verificationUriComplete) {
          console.log(`verification-uri-complete ${deviceAuth.verificationUriComplete}`);
        }
        console.error("Open the verification URI in a browser and approve this device. Waiting for approval...");
      });
      console.log("login-status success");
      console.log(`token-origin ${result.origin}`);
      console.log(`token-expires-at ${new Date(result.expiresAt).toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`login failed: ${message}`);
      console.log("login-status failed");
      loginExitCode = 1;
    } finally {
      store.close();
    }
  }
  process.exit(loginExitCode);
}

if (args.includes("--logout")) {
  const logoutUrl = peekOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  let logoutExitCode = 0;
  if (logoutUrl === null) {
    console.error("--logout requires --url (or MCP_PROBE_URL) pointing at the gateway MCP endpoint");
    console.log("logout-status failed");
    console.log("error-code SERVER_URL_UNKNOWN");
    logoutExitCode = 1;
  } else {
    // Validate the URL before consulting tokenStoreExists(): an invalid URL
    // must fail the same way regardless of whether the store happens to
    // exist yet, instead of silently reporting success when it doesn't.
    let origin: string;
    try {
      origin = new URL(logoutUrl).origin;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`--logout: invalid --url '${logoutUrl}': ${message}`);
      console.log("logout-status failed");
      console.log("error-code INVALID_URL");
      process.exit(1);
    }
    if (!tokenStoreExists()) {
      // Nothing to remove — idempotent no-op instead of creating the store.
      console.log("logout-status success");
    } else {
      const store = openTokenStore();
      try {
        store.delete(origin);
        console.log("logout-status success");
      } finally {
        store.close();
      }
    }
  }
  process.exit(logoutExitCode);
}

function parseOptions() {
  const url = readOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  const uri = readOption("uri") ?? process.env.MCP_PROBE_URI ?? REVIEW_STATUS_URI;
  const timeoutRaw = readOption("timeout-ms") ?? process.env.MCP_PROBE_TIMEOUT_MS ?? "15000";
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${timeoutRaw}`);
  }
  const authTokenFlag = readOption("auth-token");
  const authToken = authTokenFlag ?? process.env.MCP_PROBE_AUTH_TOKEN ?? null;
  const authTokenFromFlag = authTokenFlag !== undefined;
  const skipResourceListCheck =
    args.includes("--skip-resource-list-check") || process.env.MCP_PROBE_SKIP_LIST_CHECK === "true";
  const json = args.includes("--json");
  return { url, uri, timeoutMs, authToken, skipResourceListCheck, authTokenFromFlag, json };
}

/**
 * Explicit tokens (--auth-token / MCP_PROBE_AUTH_TOKEN) always win so existing
 * callers keep full control; the login cache is only consulted when no token
 * was provided. May throw AuthLoginRequiredError / AuthTimeoutError /
 * OAuthRequestError when the cached token is expired and unattended refresh
 * fails. `timeoutMs` bounds the network calls this makes so a stalled gateway
 * cannot hang past the caller's own --timeout-ms budget.
 */
async function resolveBearerToken(
  url: string,
  explicitToken: string | null,
  timeoutMs: number,
): Promise<string | null> {
  if (explicitToken !== null) {
    return explicitToken;
  }
  // Never create the token store as a probe side effect: runs that have not
  // used --login keep their exact pre-auth behavior (and stay contention-free
  // when many probes run in parallel).
  if (!tokenStoreExists()) {
    return null;
  }
  const store = openTokenStore();
  try {
    const resolved = await resolveCachedToken(url, store, { timeoutMs });
    if (resolved.source !== "none") {
      console.error(`auth token source: ${resolved.source}`);
    }
    return resolved.token;
  } finally {
    store.close();
  }
}

function printResult(result: Awaited<ReturnType<typeof runSubscribeProbe>>, url: string, uri: string): void {
  console.log(`capabilities ${JSON.stringify(result.capabilities)}`);
  console.log(`resource-found ${result.resourceFound}`);
  console.log(`resource-uri ${uri}`);
  console.log(`server-url ${url}`);
  if (result.initialText) {
    console.log("initial");
    console.log(result.initialText);
  }
  console.log(`route ${result.route}`);
  console.log(`listen-acknowledged ${result.listenAcknowledged}`);
  console.log(`honored-uris ${JSON.stringify(result.honoredUris)}`);
  console.log(`notification-received ${result.route === "subscription"}`);
  console.log(`notification-count ${result.notificationCount}`);
  console.log(`close-reason ${result.closeReason ?? "null"}`);
  const recommendedAction = extractRecommendedAction(result.finalText);
  if (recommendedAction) {
    console.log(`recommended_next_action ${recommendedAction}`);
  }
  console.log(`error-code ${result.errorCode ?? "null"}`);
  if (result.notificationUri) {
    console.log(`notification ${result.notificationUri}`);
  }
  if (result.finalText) {
    console.log("final");
    console.log(result.finalText);
  }
  const errorPart = result.errorCode ? ` error-code=${result.errorCode}` : "";
  console.log(`phase-summary route=${result.route} url=${url} uri=${uri}${errorPart}`);
}

/**
 * `call` mode: initialize → tools/call → print result. Reuses the same
 * --url / --auth-token / --login token cache / --timeout-ms / --json flags as
 * subscribe mode. Exit codes are distinct per outcome (unlike subscribe mode's
 * flat 0/1) so callers such as squirrel-notifier can branch without parsing
 * stdout: 0 success, 1 tool-level error (isError), 2 auth error, 3
 * communication/usage error.
 *
 * Sets `process.exitCode` and returns rather than calling `process.exit()`:
 * forcing immediate termination right after the SDK's Streamable HTTP
 * transport closes its SSE stream crashes Node on Windows (libuv assertion
 * `!(handle->flags & UV_HANDLE_CLOSING)` in src/win/async.c) roughly a third
 * of the time. Letting the event loop drain naturally avoids the race.
 */
async function runCallCommand(): Promise<void> {
  const jsonMode = args.includes("--json");

  // Prints the same key set (server-url/tool/is-error/error-code/
  // recommended-next-action/content) as the success path below so line-based
  // output has one consistent shape for machine parsers, matching the --json
  // error shape (isError: true, content: null).
  function emitError(
    errorCode: string,
    exitCode: number,
    url: string | null,
    tool: string | null,
    recommendedNextAction: string | null = null,
  ): void {
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify(buildCallErrorJsonOutput(errorCode, url, tool, recommendedNextAction))}\n`,
      );
    } else {
      console.log(`server-url ${url ?? "unknown"}`);
      console.log(`tool ${tool ?? "unknown"}`);
      console.log("is-error true");
      console.log(`error-code ${errorCode}`);
      console.log(`recommended-next-action ${recommendedNextAction ?? "null"}`);
      console.log("content");
      console.log("null");
    }
    process.exitCode = exitCode;
  }

  let url: string | null = null;
  let tool: string | null = null;
  let timeoutMs = 15000;
  let toolArgs: Record<string, unknown> = {};
  let authToken: string | null = null;
  let authTokenFromFlag = false;

  try {
    url = readOption("url") ?? process.env.MCP_PROBE_URL ?? null;
    tool = readOption("tool") ?? null;
    const timeoutRaw = readOption("timeout-ms") ?? process.env.MCP_PROBE_TIMEOUT_MS ?? "15000";
    timeoutMs = Number(timeoutRaw);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid --timeout-ms: ${timeoutRaw}`);
    }
    const authTokenFlag = readOption("auth-token");
    authToken = authTokenFlag ?? process.env.MCP_PROBE_AUTH_TOKEN ?? null;
    authTokenFromFlag = authTokenFlag !== undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`call failed: ${message}`);
    emitError("INTERNAL_ERROR", 3, url, tool);
    return;
  }

  if (url === null) {
    emitError("SERVER_URL_UNKNOWN", 3, url, tool);
    return;
  }
  if (tool === null) {
    emitError("TOOL_NAME_REQUIRED", 3, url, tool);
    return;
  }

  try {
    const argsRaw = readOption("args") ?? "{}";
    const parsed: unknown = JSON.parse(argsRaw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--args must be a JSON object");
    }
    toolArgs = parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`call failed: invalid --args: ${message}`);
    emitError("INVALID_ARGS", 3, url, tool);
    return;
  }

  if (authTokenFromFlag) {
    console.warn(
      "warning: --auth-token value is visible in process lists and may be stored in shell history. Prefer MCP_PROBE_AUTH_TOKEN env var.",
    );
  }

  try {
    const authStart = Date.now();
    const bearerToken = await resolveBearerToken(url, authToken, timeoutMs);
    const remainingTimeoutMs = Math.max(0, timeoutMs - (Date.now() - authStart));
    const result = await runToolCall({
      url,
      tool,
      args: toolArgs,
      timeoutMs: remainingTimeoutMs,
      requestHeaders: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      clientVersion: pkg.version,
    });

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(buildCallJsonOutput(result, url, tool))}\n`);
    } else {
      console.log(`server-url ${url}`);
      console.log(`tool ${tool}`);
      console.log(`is-error ${result.isError}`);
      console.log(`error-code ${result.isError ? "TOOL_ERROR" : "null"}`);
      console.log("recommended-next-action null");
      console.log("content");
      console.log(JSON.stringify(result.content));
    }
    if (result.isError) {
      process.exitCode = 1;
    }
  } catch (error) {
    let errorCode = "CALL_FAILED";
    let exitCode = 3;
    let recommendedNextAction: string | null = null;
    if (error instanceof AuthLoginRequiredError) {
      errorCode = "AUTH_LOGIN_REQUIRED";
      exitCode = 2;
      console.error(`hint: run \`mcp-resource-subscriber --login --url ${url}\` to re-authenticate`);
    } else if (error instanceof AuthTimeoutError) {
      errorCode = "AUTH_TIMEOUT";
      exitCode = 2;
    } else if (error instanceof OAuthRequestError) {
      errorCode = "AUTH_REFRESH_FAILED";
      exitCode = 2;
    } else if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) {
      errorCode = "AUTH_FAILED";
      exitCode = 2;
    } else if (error instanceof ProtocolNegotiationError) {
      errorCode = "PROTOCOL_UNSUPPORTED";
      exitCode = 3;
      recommendedNextAction = PROTOCOL_UNSUPPORTED_HINT;
      console.error(`hint: ${PROTOCOL_UNSUPPORTED_HINT}`);
    } else if (
      error instanceof ProtocolError &&
      (error.code === ProtocolErrorCode.InvalidParams || error.code === ProtocolErrorCode.MethodNotFound)
    ) {
      // 不明な tool 名・不正な引数は、tool の実行失敗（isError）ではなく
      // tools/call 自体の拒否として返る。通信エラーと同じ袋に入れない。
      errorCode = "TOOL_REQUEST_REJECTED";
      exitCode = 3;
      recommendedNextAction = TOOL_REQUEST_REJECTED_HINT;
      console.error(`hint: ${TOOL_REQUEST_REJECTED_HINT}`);
    } else {
      const classified = classifyNetworkError(error);
      if (classified) {
        errorCode = classified.errorCode;
        recommendedNextAction = classified.recommendedNextAction;
        console.error(`hint: ${classified.recommendedNextAction}`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`call failed: ${message}`);
    emitError(errorCode, exitCode, url, tool, recommendedNextAction);
  }
}

if (args[0] === "call") {
  // call mode has its own argument parsing / output / exit-code scheme;
  // never fall through into the subscribe flow below.
  await runCallCommand();
} else {
  // Capture context outside try so the catch block can report actuals instead of unknowns.
  // Use peekOption (no-throw) so malformed args don't produce a bare stack trace before the try.
  const jsonMode = args.includes("--json");
  let capturedUrl: string | null = peekOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  let capturedUri: string = peekOption("uri") ?? process.env.MCP_PROBE_URI ?? REVIEW_STATUS_URI;

  try {
    const options = parseOptions();
    capturedUrl = options.url;
    capturedUri = options.uri;

    if (options.url === null) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(buildErrorJsonOutput("SERVER_URL_UNKNOWN", null, options.uri))}\n`);
      } else {
        console.log("error-code SERVER_URL_UNKNOWN");
        console.log("phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN");
      }
      process.exitCode = 1;
    } else {
      if (options.uri === REVIEW_STATUS_URI && !readOption("uri") && !process.env.MCP_PROBE_URI) {
        console.warn(
          "warning: using default URI test://review/status which is only meaningful against the bundled test server",
        );
      }
      if (options.authTokenFromFlag) {
        console.warn(
          "warning: --auth-token value is visible in process lists and may be stored in shell history. Prefer MCP_PROBE_AUTH_TOKEN env var.",
        );
      }
      const authStart = Date.now();
      const bearerToken = await resolveBearerToken(options.url, options.authToken, options.timeoutMs);
      const remainingTimeoutMs = Math.max(0, options.timeoutMs - (Date.now() - authStart));
      const result = await runSubscribeProbe({
        url: options.url,
        uri: options.uri,
        timeoutMs: remainingTimeoutMs,
        requestHeaders: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
        skipResourceListCheck: options.skipResourceListCheck,
        clientVersion: pkg.version,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(buildJsonOutput(result, options.url, options.uri))}\n`);
      } else {
        printResult(result, options.url, options.uri);
      }
      if (result.errorCode) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`subscribe-probe failed: ${message}`);
    let errorCode = "INTERNAL_ERROR";
    let recommendedNextAction: string | null = null;
    if (error instanceof AuthLoginRequiredError) {
      errorCode = "AUTH_LOGIN_REQUIRED";
      console.error(
        `hint: run \`mcp-resource-subscriber --login --url ${capturedUrl ?? "<gateway-url>"}\` to re-authenticate`,
      );
    } else if (error instanceof AuthTimeoutError) {
      // The gateway accepted the connection but never responded within the
      // --timeout-ms budget; cached credentials may still be fine, so a plain
      // retry (unlike AUTH_LOGIN_REQUIRED) is reasonable.
      errorCode = "AUTH_TIMEOUT";
    } else if (error instanceof OAuthRequestError) {
      // Transient gateway-side refresh failure (5xx / temporarily_unavailable);
      // the refresh token was restored server-side, so a plain retry is enough.
      errorCode = "AUTH_REFRESH_FAILED";
    } else if (error instanceof ProtocolNegotiationError) {
      errorCode = "PROTOCOL_UNSUPPORTED";
      recommendedNextAction = PROTOCOL_UNSUPPORTED_HINT;
      console.error(`hint: ${PROTOCOL_UNSUPPORTED_HINT}`);
    } else {
      const classified = classifyNetworkError(error);
      if (classified) {
        errorCode = classified.errorCode;
        recommendedNextAction = classified.recommendedNextAction;
        console.error(`hint: ${classified.recommendedNextAction}`);
      }
    }
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify(buildErrorJsonOutput(errorCode, capturedUrl, capturedUri, recommendedNextAction))}\n`,
      );
    } else {
      console.log(`error-code ${errorCode}`);
      console.log(`recommended-next-action ${recommendedNextAction ?? "null"}`);
      console.log(
        `phase-summary route=failed url=${capturedUrl ?? "unknown"} uri=${capturedUri} error-code=${errorCode}`,
      );
    }
    process.exitCode = 1;
  }
}
