# mcp-resource-subscriber

CLI probe for MCP resource subscriptions — connects to any MCP Streamable HTTP server, opens a `subscriptions/listen` stream for a resource, receives live update notifications, and re-reads updated content.

> **Protocol**: this CLI speaks MCP protocol revision **`2026-07-28` only**. It pins negotiation to that revision and never falls back to the 2025-era `resources/subscribe` path — a server that cannot offer `2026-07-28` fails with `PROTOCOL_UNSUPPORTED`.

---

## Install

```bash
# recommended (no install):
pnpm dlx mcp-resource-subscriber --url <mcp-server-url> --uri <resource-uri>

# or install globally:
pnpm add --global mcp-resource-subscriber
mcp-resource-subscriber --url <mcp-server-url> --uri <resource-uri>
```

> **パッケージマネージャー方針**: このリポジトリと README の利用例は pnpm を前提にしています。pnpm がない環境では、先に pnpm を利用できる状態にしてください。

> **Note**: A reference MCP test server used during compatibility verification is also included in this repository (Docker Compose). See the [Lab Server](#lab-server) section below.

---

## CLI Usage

### Against `copilot-review-mcp`

```bash
mcp-resource-subscriber \
  --url http://127.0.0.1:8080/mcp/copilot-review \
  --uri copilot-review://watch/<watch_id> \
  --timeout-ms 900000
```

`copilot-review-mcp` is the `@scottlz0310/copilot-review-mcp` server. Replace `<watch_id>` with the ID returned by `start_copilot_review_watch`.

### Against the bundled test server

```bash
# Start the test server first:
docker compose up --build
# or: pnpm run dev

mcp-resource-subscriber --url http://127.0.0.1:8089/mcp
```

> **Note**: `test://review/status` is the default resource URI and is **only meaningful against the bundled test server**. For any other MCP server, always pass `--uri` explicitly.

### Calling a tool once instead of subscribing

For a single `tools/call` invocation with no subscription/wait, use the `call` subcommand — see [`call` mode](#call-mode-single-toolscall-invocation) below.

### Options

```
  --url <url>         MCP server Streamable HTTP endpoint (required)
                      Env: MCP_PROBE_URL
  --uri <uri>         Resource URI to subscribe to
                      Default: test://review/status (bundled test server only)
                      Env: MCP_PROBE_URI
  --auth-token <tok>  Bearer token for Authorization header
                      Prefer MCP_PROBE_AUTH_TOKEN env var (flag is visible in
                      process lists and may be stored in shell history)
                      Env: MCP_PROBE_AUTH_TOKEN (recommended)
  --login             Interactive device-flow login (RFC 8628) against the
                      gateway serving --url. Caches the issued tokens so later
                      runs authenticate and refresh automatically.
                      Cache path env: MCP_PROBE_TOKEN_STORE_PATH
  --logout             Remove the cached token set for the gateway serving --url.
                      Use after a gateway rebuild or DCR store reset so the
                      next --login registers a fresh client.
  --skip-resource-list-check
                      Skip resources/list and assume the URI exists.
                      Use for servers with dynamic resources not in list.
                      Env: MCP_PROBE_SKIP_LIST_CHECK=true
  --timeout-ms <ms>   Notification wait timeout in ms (default: 15000)
                      Env: MCP_PROBE_TIMEOUT_MS
  --json              Emit a single JSON object to stdout instead of line-based output.
                      Diagnostic messages are written to stderr only.
  --version, -v       Print version and exit
  --help, -h          Print this help and exit
```

### Gateway authentication (`--login`)

When subscribing through an [mcp-gateway](https://github.com/scottlz0310/mcp-gateway), run a one-time
interactive login instead of provisioning `MCP_PROBE_AUTH_TOKEN` by hand:

```bash
mcp-resource-subscriber --login --url http://127.0.0.1:8080/mcp/subscribe-probe
```

This performs RFC 7591 dynamic client registration and the RFC 8628 device
authorization flow against the gateway origin: it prints a `user-code` and a
`verification-uri-complete` line, waits while you approve the device in a
browser, then caches the issued `access_token` / `refresh_token`.

Later probe runs against the same origin then work unattended:

1. An explicit `--auth-token` / `MCP_PROBE_AUTH_TOKEN` always wins and skips the cache
   (existing callers such as `MCP_PROBE_AUTH_TOKEN=$(gh auth token)` keep working unchanged).
2. Otherwise a cached token for the `--url` origin is used while still fresh.
3. An expired cached token is renewed automatically via the refresh grant.
   The gateway rotates refresh tokens on every renewal; the rotated token is persisted immediately.
4. If the refresh token itself is rejected (`invalid_grant`), the run fails with
   `error-code AUTH_LOGIN_REQUIRED` — run `--login` once more. Transient gateway
   errors during refresh fail with `AUTH_REFRESH_FAILED` and can simply be retried.
5. If the gateway no longer recognizes the cached client at all (`invalid_client` /
   `unauthorized_client` — e.g. after a gateway rebuild or DCR store reset), the run
   also fails with `AUTH_LOGIN_REQUIRED`. Running `--login` again automatically
   registers a fresh client when the cached one is rejected; `--logout` clears the
   stale entry outright if you want to force that.
6. Auth resolution (cross-process refresh lock wait + endpoint discovery + refresh
   grant) is bounded by `--timeout-ms`, the same budget used for the notification
   wait. A gateway that accepts the connection but never responds fails with
   `error-code AUTH_TIMEOUT` (a plain retry is reasonable) instead of hanging
   past the requested timeout.

Runs that never used `--login` do not create the cache and behave exactly as before.

The token cache is a SQLite database (one row per gateway origin) stored under the
OS state directory, owner-only permissions:

| OS | Default path |
|----|--------------|
| Windows | `%LOCALAPPDATA%\mcp-resource-subscriber\tokens.db` |
| macOS | `~/Library/Application Support/mcp-resource-subscriber/tokens.db` |
| Linux | `$XDG_STATE_HOME/mcp-resource-subscriber/tokens.db` (fallback `~/.local/state/...`) |

Override with `MCP_PROBE_TOKEN_STORE_PATH`. Token values are never printed to stdout/stderr.

### JSON output mode

Pass `--json` to emit a single JSON object to stdout for agent workflow integration:

```bash
mcp-resource-subscriber \
  --url http://localhost:3000/mcp \
  --uri queue://review/re-review-requests \
  --timeout-ms 900000 \
  --json
```

Success output:

```json
{
  "route": "subscription",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "listenAcknowledged": true,
  "honoredUris": ["queue://review/re-review-requests"],
  "notificationReceived": true,
  "notificationCount": 1,
  "closeReason": "local",
  "errorCode": null,
  "initialText": "...",
  "finalText": "...",
  "recommendedNextAction": null
}
```

Failure output (same shape with non-null `errorCode`):

```json
{
  "route": "timeout",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "listenAcknowledged": true,
  "honoredUris": ["queue://review/re-review-requests"],
  "notificationReceived": false,
  "notificationCount": 0,
  "closeReason": "local",
  "errorCode": "NOTIFICATION_TIMEOUT",
  "initialText": null,
  "finalText": null,
  "recommendedNextAction": null
}
```

- `route`: `"subscription"` | `"pre-completion"` | `"timeout"` | `"failed"`
- `listenAcknowledged`: `true` once the server answered `subscriptions/listen` with `notifications/subscriptions/acknowledged`
- `honoredUris`: the resource URIs the server actually honored, taken from that acknowledgement. A requested URI missing here fails with `SUBSCRIPTION_NOT_HONORED` instead of waiting for a notification that can never arrive
- `closeReason`: how the listen stream ended — `"local"` (this CLI closed it), `"graceful"` (the server ended it deliberately), `"remote"` (dropped without a response — reported as `SUBSCRIPTION_DISCONNECTED`), or `null`
- `notificationReceived`: `true` when `route === "subscription"`
- `recommendedNextAction`: extracted from `finalText` if present, otherwise `null`. On network-level failures (`TLS_CERT_UNTRUSTED`, `DNS_LOOKUP_FAILED`, `CONNECTION_REFUSED`) this is instead a client-generated remediation hint — see [Network error classification](#network-error-classification) below.
- If `finalText` is JSON, callers can parse it themselves
- Diagnostic warnings (e.g. `--auth-token` flag warning) go to stderr and do not corrupt stdout JSON

### `call` mode (single `tools/call` invocation)

Invoke any MCP tool once and exit — no subscription, no wait. Reuses the same
`--url` / `--auth-token` / `--login` token cache / `--timeout-ms` / `--json`
flags as subscribe mode:

```bash
mcp-resource-subscriber call \
  --url https://gateway.example/mcp/thread-owl \
  --tool enqueue_review \
  --args '{"owner":"scottlz0310","repo":"example","prNumber":123,"reason":"opened"}' \
  --json
```

Options specific to `call` mode:

```
  --tool <name>       MCP tool name to invoke (required)
  --args <json>       JSON object of tool arguments (default: {})
```

Exit codes are distinct per outcome, so callers can branch on `$?` alone
without parsing stdout:

| Exit code | Meaning | `errorCode` examples |
|---|---|---|
| `0` | Success | — |
| `1` | Tool-level error (the tool ran and returned `isError: true`) | `TOOL_ERROR` |
| `2` | Auth error | `AUTH_LOGIN_REQUIRED`, `AUTH_TIMEOUT`, `AUTH_REFRESH_FAILED`, `AUTH_FAILED` |
| `3` | Communication / usage / protocol error | `SERVER_URL_UNKNOWN`, `TOOL_NAME_REQUIRED`, `INVALID_ARGS`, `TOOL_REQUEST_REJECTED`, `PROTOCOL_UNSUPPORTED`, `CALL_FAILED`, `INTERNAL_ERROR`, `TLS_CERT_UNTRUSTED`, `DNS_LOOKUP_FAILED`, `CONNECTION_REFUSED` |

`--json` output shape:

```json
{
  "serverUrl": "https://gateway.example/mcp/thread-owl",
  "tool": "enqueue_review",
  "isError": false,
  "errorCode": null,
  "content": [{ "type": "text", "text": "..." }],
  "recommendedNextAction": null
}
```

`content` is the raw MCP `CallToolResult.content` array (verbatim from the
server); parse it yourself if it contains JSON text. Line-based (non-JSON)
output always prints the same six fields — `server-url`, `tool`, `is-error`,
`error-code`, `recommended-next-action`, and a `content` block — for both
success and error outcomes, so machine parsers can rely on a single shape:
`content` is the JSON-stringified content array on success, or the literal
`null` when the call never reached the tool (e.g. a communication or auth
error); `recommended-next-action` is `null` except on network-level errors
(see [Network error classification](#network-error-classification)).

> **Note**: an unknown tool name (and invalid arguments) is rejected by the
> server before the tool runs, so it surfaces as exit code `3` /
> `TOOL_REQUEST_REJECTED` — not `1` / `TOOL_ERROR`, which is reserved for a
> tool that ran and returned `isError: true`.

### Structured line-based output (default)

Every run emits machine-parseable lines:

```
capabilities {"subscribe":true,"listChanged":false}
resource-found true
resource-uri <resource-uri>
server-url <url>
initial
<initial resource text>
route subscription
listen-acknowledged true
honored-uris ["<resource-uri>"]
notification-received true
notification-count 1
close-reason local
recommended_next_action READ_REVIEW_THREADS
error-code null
notification <resource-uri>
final
<updated resource text>
phase-summary route=subscription url=<url> uri=<uri>
```

> **Note**: `recommended_next_action` is only emitted when the final resource text contains it (e.g., from `copilot-review-mcp`). It is omitted for the bundled test server.

`recommended_next_action=POLL_AFTER` は非終端状態として扱われます。この場合、CLI は exit せず、同じ `subscriptions/listen` stream を維持したまま次の `notifications/resources/updated` を待ちます。`--timeout-ms` は ack 後の全体待機上限です。

On failure:

```
error-code SERVER_URL_UNKNOWN
phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN
```

```
error-code RESOURCE_NOT_FOUND
phase-summary route=timeout url=<url> uri=<uri> error-code=RESOURCE_NOT_FOUND
```

```
error-code NOTIFICATION_TIMEOUT
phase-summary route=timeout url=<url> uri=<uri> error-code=NOTIFICATION_TIMEOUT
```

```
error-code PROTOCOL_UNSUPPORTED
recommended-next-action The server does not offer MCP protocol revision 2026-07-28. ...
phase-summary route=failed url=<url> uri=<uri> error-code=PROTOCOL_UNSUPPORTED
```

### Network error classification

Low-level network failures that Node's `fetch` otherwise flattens into a
generic `INTERNAL_ERROR` / `CALL_FAILED` are classified into a dedicated
`errorCode` with a `recommendedNextAction` remediation hint, in both `subscribe`
and `call` mode (`--json` and line-based `recommended-next-action <text>`):

| `errorCode` | Cause | Hint |
|---|---|---|
| `TLS_CERT_UNTRUSTED` | The server's TLS certificate is not trusted (self-signed, expired, or a local CA not in the trust store — e.g. mkcert) | Set `NODE_EXTRA_CA_CERTS` to the CA root, or run with `NODE_USE_SYSTEM_CA=1` if the CA is in the OS trust store |
| `DNS_LOOKUP_FAILED` | `--url`'s hostname could not be resolved | Check for typos and DNS connectivity |
| `CONNECTION_REFUSED` | The server refused the TCP connection | Check that `--url`'s host and port are correct and the server is running |

---

## Lab Server

Minimal MCP Streamable HTTP server for testing whether MCP clients correctly handle `subscriptions/listen` and `notifications/resources/updated`.

This repository is meant to be a reproducible issue / compatibility lab for CLI AI agents such as Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, and Crush.

## Purpose

The server exposes one fixed MCP resource:

```text
test://review/status
```

Initial content:

```text
status: pending
version: 1
message: Waiting for simulated review result.
```

After a client opens a `subscriptions/listen` stream for the resource, the server waits for `MCP_TEST_UPDATE_DELAY_SECONDS`, changes the resource, and sends:

```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "test://review/status"
  }
}
```

Updated content:

```text
status: reviewed
version: 2
message: Simulated review result is now available.
```

## Why Resource Subscriptions Instead Of Tools/Call

`tools/call` is useful for explicit actions, but many agent workflows depend on context that changes after the original request. Polling every source is noisy and client-specific. MCP resource subscriptions give clients a protocol-level way to learn that a known context object changed and should be re-read.

Examples where subscription behavior matters:

- Copilot review result
- PR review thread
- CI status
- Codecov comment
- GitHub issue discussion
- local build/test result

This test server focuses on whether the client notices a resource update, re-runs `resources/read`, and reflects the new content in the agent loop / model context.

This is a statement about the *bundled reference server's* design, not a restriction on the CLI: the [`call` mode](#call-mode-single-toolscall-invocation) is a deliberate, separate escape hatch for callers that need a single `tools/call` invocation against *any* MCP server (e.g. triggering a one-off action tool) without standing up a subscription.

## Start

```bash
docker compose up --build
```

MCP URL:

```text
http://127.0.0.1:8089/mcp
```

For local development:

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `MCP_TEST_PORT` | `8089` | TCP port the server listens on |
| `MCP_TEST_PATH` | `/mcp` | Additional MCP endpoint path. The server always registers `/mcp`; this adds a second path (e.g. `/mcp/subscribe-probe` for gateway routing). Both paths share the same MCP handler. |
| `MCP_TEST_UPDATE_DELAY_SECONDS` | `5` | Seconds to wait before sending the resource update notification |
| `MCP_TEST_INITIAL_STATUS` | `pending` | Initial value of the `status` field in the resource |
| `MCP_TEST_UPDATED_STATUS` | `reviewed` | Value of `status` after the simulated update |
| `MCP_TEST_SEND_LIST_CHANGED` | `false` | Also send `notifications/resources/list_changed` after the update |
| `MCP_TEST_LOG_LEVEL` | `debug` | Log verbosity (`debug` / `info` / `warn` / `error` / `silent`) |

If `MCP_TEST_SEND_LIST_CHANGED=true`, the server also sends `notifications/resources/list_changed` after the simulated update.

## Expected Client Behavior

An ideal MCP client should follow this flow:

```text
server/discover                       (negotiate 2026-07-28)
  ↓
resources/list
  ↓
resources/read test://review/status
  ↓
subscriptions/listen { notifications: { resourceSubscriptions: ["test://review/status"] } }
  ↓
receive notifications/subscriptions/acknowledged   (MUST arrive first; check the honored filter)
  ↓
receive notifications/resources/updated            (on the same long-lived SSE stream)
  ↓
resources/read test://review/status again
  ↓
reflect updated status: reviewed in agent context
  ↓
close the stream                       (there is no resources/unsubscribe in 2026-07-28)
```

The server has no protocol-level session: the subscription lives exactly as long
as the `subscriptions/listen` HTTP request. A stream that ends without a
response is an abnormal disconnect, not a clean unsubscribe.

## Server Capabilities

The initialize response advertises:

```json
{
  "resources": {
    "subscribe": true,
    "listChanged": false
  }
}
```

`listChanged` follows `MCP_TEST_SEND_LIST_CHANGED`. `subscribe: true` now means
"individual resource updates can be requested through `resourceSubscriptions`",
not that `resources/subscribe` exists.

## Implemented MCP Messages

- `server/discover` (`2026-07-28` only — a 2025-era `initialize` is rejected with `-32022`)
- `resources/list`
- `resources/read`
- `subscriptions/listen` + `notifications/subscriptions/acknowledged`
- `notifications/resources/updated`
- `notifications/resources/list_changed` when `MCP_TEST_SEND_LIST_CHANGED=true`
- GET / DELETE on the MCP endpoint answer `405`: the standalone GET SSE endpoint and `Mcp-Session-Id` sessions no longer exist
- `tools/list`, `tools/call`:
  - `get_review_status` — returns the current review status (same data as reading `test://review/status`)
  - `echo_tool` — testing utility for `call` mode; echoes `{ message }` back as text content, or returns `isError: true` when called with `{ shouldError: true }`

## Logs

The server logs each important message so client behavior can be checked objectively:

```text
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
```

The key evidence for resource subscription support is:

```text
subscriptions/listen was acknowledged
notification was sent on that stream
resources/read was received again after the notification
```

## Tests

```bash
pnpm test
```

The test suite verifies:

- `resources/list` returns `test://review/status`
- initial `resources/read` returns version 1
- opening a `subscriptions/listen` stream triggers an internal update to version 2
- `notifications/resources/updated` is received
- updated `resources/read` returns version 2
- repeated probes against the same server process each observe the update

## Standalone Subscription Probe Client

The repository also includes a reusable MCP SDK client that exercises the full subscription flow against a running server:

```bash
pnpm run probe:subscribe -- --url http://127.0.0.1:8089/mcp
```

After `pnpm run build`, the same client can be run directly with Node:

```bash
node dist/src/client/cli.js --url http://127.0.0.1:8089/mcp
```

This client is separate from any AI client's native MCP surface. For Codex CLI, it demonstrates a reproducible agent-driven SDK workaround: if the agent has shell, Node.js, local dependency, and localhost network access, it can run this client to open a `subscriptions/listen` stream, receive `notifications/resources/updated`, and re-read the updated resource.

## Verification Procedure

Use [`docs/verification-guide.md`](docs/verification-guide.md) for a repeatable client verification procedure.

Record results in [`results/compatibility-matrix.md`](results/compatibility-matrix.md).

> **Historical**: the verification guides and the compatibility matrices under
> [`results/`](results) were produced against the 2025-era protocol, before this repository
> moved to `2026-07-28`. Their `resources/subscribe` / `resources/unsubscribe` steps no
> longer apply to the server described above — the flow is now the one in
> [Expected Client Behavior](#expected-client-behavior). They are kept as a record of the
> compatibility spike, not as instructions to follow.

## Skill Templates

Reusable Codex skill templates are tracked under [`docs/skills`](docs/skills). The `pr-review-subscribe` template documents a PR review cycle that uses an MCP resource subscription as the primary wait route and polling only as fallback. It predates the `2026-07-28` migration and still describes the 2025-era `resources/subscribe` wire calls; the wait strategy carries over, the RPC names do not.

## Client Compatibility

See [`results/compatibility-matrix-v2.md`](results/compatibility-matrix-v2.md) for the current Round 2 compatibility matrix (tool + resource testing) across Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, and Crush.
