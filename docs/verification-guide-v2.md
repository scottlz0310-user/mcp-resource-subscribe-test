# Verification Guide — Round 2 (with tools)

> **Historical (pre-`2026-07-28`)**: this document records the 2025-era compatibility spike.
> The reference server no longer implements `resources/subscribe` / `resources/unsubscribe` —
> it speaks MCP `2026-07-28` and answers a 2025-era `initialize` with `-32022`. Following the
> steps below against the current server will fail. See the README's
> [Expected Client Behavior](../README.md#expected-client-behavior) for the flow in use today.

This guide covers the **second round** of compatibility verification, using a server that exposes both resources *and* a tool.

Round 1 results (resource-only server) are in [`results/compatibility-matrix.md`](../results/compatibility-matrix.md) and remain valid as a baseline.

## Motivation

In Round 1, several clients reached only Level 1 because the MCP server exposed no tools:

| Client | Round 1 result | Root cause |
| --- | --- | --- |
| Codex CLI | 1 - connected | Resource-only server; no tool surface for the agent |
| OpenCode | 1 - connected | `tools/list` -> "Failed to get tools"; server hidden from agent |
| Crush | 1 - connected | `tools/list` -> "Method not found"; server hidden from agent |
| GitHub Copilot CLI | 1 - connected | Resource-only server; no tool surface for the agent |

Round 2 adds `get_review_status` to the server so that `tools/list` returns a non-empty response.
This removes the error-on-tools-list blocker and allows deeper resource behavior to be observed.

## New Tool

| Tool name | Description |
| --- | --- |
| `get_review_status` | Returns the current review status. Same content as `resources/read test://review/status`. |

The tool logs `[tools/call] get_review_status` in the server log.

## Goal

Same as Round 1, plus verify that the added tool does not interfere with resource subscription:

1. Client connects and calls `initialize`.
2. Client calls `tools/list` -> receives `[get_review_status]` without error.
3. Client calls `resources/list`.
4. Client calls `resources/read` for `test://review/status`.
5. Client sends `resources/subscribe`.
6. Client receives `notifications/resources/updated`.
7. Client calls `resources/read` again after the notification.
8. Client reflects `status: reviewed` and `version: 2` in the agent response.

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

Use a fresh server run for each client:

```bash
docker compose down
docker compose up --build
```

## Test Prompt

Use the same prompt as Round 1 when possible:

```text
Check the available MCP resources.
Read test://review/status.
If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification.
After the notification, read test://review/status again.
Report the final status, version, and message.
```

If the client exposes tools but not raw resource methods, also try:

```text
Use the get_review_status tool to read the current review status.
```

## Expected Server Log

Ideal full-support log (same as Round 1):

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resources/subscribe] uri=test://review/status
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
```

Tool call (optional):

```text
[tools/call] get_review_status
```

## Result Levels

Same resource-based progression as Round 1. Round 2 tool discovery and tool calls
confirm the tool surface, but do not raise the result level unless a resource method
appears in the server log.

| Level | Evidence |
| --- | --- |
| `0 - no connection` | No `[initialize]` log. |
| `1 - connected` | `[initialize]` appears and no `resources/*` methods appear. Optional tool discovery or `[tools/call]` activity still counts as Level 1 when no resource methods are exercised. |
| `2 - discovered` | `[resources/list]` appears. |
| `3 - read initial resource` | `[resources/read]` with `version=1`. |
| `4 - subscribed` | `[resources/subscribe]` appears. |
| `5 - notification path active` | Server sends `notifications/resources/updated`. |
| `6 - re-read after update` | `[resources/read]` with `version=2`. |
| `7 - agent context updated` | Agent reports `status: reviewed` and `version: 2`. |

## What To Record

Record results in [`results/compatibility-matrix-v2.md`](../results/compatibility-matrix-v2.md).

For each client, include:

- client name and version
- OS and shell
- MCP endpoint configuration
- prompt used
- observed server log excerpt
- result level
- comparison with Round 1 result
- notes about tool usage vs. resource usage
