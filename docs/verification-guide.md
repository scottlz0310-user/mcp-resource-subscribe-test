# Verification Guide

> **Historical (pre-`2026-07-28`)**: this document records the 2025-era compatibility spike.
> The reference server no longer implements `resources/subscribe` / `resources/unsubscribe` —
> it speaks MCP `2026-07-28` and answers a 2025-era `initialize` with `-32022`. Following the
> steps below against the current server will fail. See the README's
> [Expected Client Behavior](../README.md#expected-client-behavior) for the flow in use today.

This guide defines a repeatable procedure for checking whether an MCP client supports `resources/subscribe` and `notifications/resources/updated`.

## Goal

For each client, verify these behaviors:

1. It connects to the MCP Streamable HTTP endpoint.
2. It calls `resources/list`.
3. It calls `resources/read` for `test://review/status`.
4. It recognizes the `capabilities.resources.subscribe` flag advertised during `initialize`.
5. It sends `resources/subscribe`.
6. It receives `notifications/resources/updated`.
7. It calls `resources/read` again after the notification.
8. It reflects `status: reviewed` and `version: 2` in the agent response.

## Server Setup

Start the server:

```bash
docker compose up --build
```

MCP endpoint:

```text
http://127.0.0.1:8089/mcp
```

Watch logs in another terminal:

```bash
docker compose logs -f
```

Use a fresh server run for each client when possible:

```bash
docker compose down
docker compose up --build
```

## Test Prompt

Use the same prompt for every client when possible:

```text
Check the available MCP resources.
Read test://review/status.
If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification.
After the notification, read test://review/status again.
Report the final status, version, and message.
```

If the client needs a more explicit instruction:

```text
Use MCP resources/list, resources/read, and resources/subscribe if available.
The resource URI is test://review/status.
Wait up to 10 seconds for notifications/resources/updated.
Then read the resource again and report whether version: 2 and status: reviewed are visible.
```

## Expected Server Log

Full support should produce this sequence:

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resources/subscribe] uri=test://review/status
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
```

`resources/unsubscribe` may also appear if the client cleans up the subscription:

```text
[resources/unsubscribe] uri=test://review/status
```

## Result Levels

Use these levels when summarizing client behavior:

| Level | Evidence |
| --- | --- |
| `0 - no connection` | No `[initialize]` log appears. |
| `1 - connected` | `[initialize]` appears, but no resource calls appear. |
| `2 - discovered` | `resources/list` appears. |
| `3 - read initial resource` | `resources/read` appears with `version=1`. |
| `4 - subscribed` | `resources/subscribe` appears. |
| `5 - notification path active` | The server sends `notifications/resources/updated` after subscription. |
| `6 - re-read after update` | `resources/read` appears again with `version=2`. |
| `7 - agent context updated` | The agent answer reports `status: reviewed` and `version: 2`. |

## Optional List Changed Test

The server can also emit `notifications/resources/list_changed`.

PowerShell:

```powershell
$env:MCP_TEST_SEND_LIST_CHANGED="true"
docker compose up --build
```

Bash:

```bash
MCP_TEST_SEND_LIST_CHANGED=true docker compose up --build
```

This option checks whether the client distinguishes an individual resource update from a resource list update.

## What To Record

Record results in [`results/compatibility-matrix.md`](../results/compatibility-matrix.md).

For each client, include:

- client name and version
- OS and shell
- MCP endpoint configuration
- prompt used
- observed server log excerpt
- result level
- final agent-visible resource content
- notes about manual steps or client limitations
