# Verification Prompt — Round 2 (with tools)

> **Historical (pre-`2026-07-28`)**: this document records the 2025-era compatibility spike.
> The reference server no longer implements `resources/subscribe` / `resources/unsubscribe` —
> it speaks MCP `2026-07-28` and answers a 2025-era `initialize` with `-32022`. Following the
> steps below against the current server will fail. See the README's
> [Expected Client Behavior](../README.md#expected-client-behavior) for the flow in use today.

This prompt template is designed to be passed to another MCP client agent for Round 2 verification.  
Replace `<CLIENT_NAME>` with the target client name before use.

---

## Prompt to paste into the target client

```
You are an MCP client compatibility verifier for <CLIENT_NAME>.

Please read the following files first:

- docs/verification-guide-v2.md
- results/compatibility-matrix-v2.md

Then follow the steps in docs/verification-guide-v2.md to verify <CLIENT_NAME> against the test MCP server, and record the results in the `## <CLIENT_NAME>` section of results/compatibility-matrix-v2.md.

You may only edit results/compatibility-matrix-v2.md.

Do not:
- modify implementation code
- modify Dockerfile, package files, or server files
- fix the verification server for convenience
- write "Supported" based on guesswork
- record MCP messages as observed if they do not appear in the server log
- perform unrelated refactoring
- make large unauthorized changes to README or design documents

Use server logs as the primary source of truth.

Key log lines to look for:
- Resource discovery:    [resources/list] requested
- Initial read:          [resources/read] uri=test://review/status version=1
- Subscription:          [resources/subscribe] uri=test://review/status
- Notification sent:     [notification/send] notifications/resources/updated uri=test://review/status
- Post-notification read: [resources/read] uri=test://review/status version=2
- Tool call:             [tools/call] get_review_status

After completing the verification, report only:
- Client name and version
- OS and shell
- Result Level (0-7)
- Observed MCP messages (from server log)
- Whether resources/subscribe was reached
- Whether the agent reported status: reviewed and version: 2
- Files updated
```

---

## Test Prompts (to use inside the client being tested)

### Primary prompt (resource path)

```
Check the available MCP resources.
Read test://review/status.
If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification.
After the notification, read test://review/status again.
Report the final status, version, and message.
```

### Fallback prompt (tool path, use if primary prompt fails or client lacks resource API)

```
Use the get_review_status tool to read the current review status.
```

---

## Server Setup

Start a fresh server before each client test:

```bash
docker compose down
docker compose up --build
```

MCP endpoint (direct):

```text
http://127.0.0.1:8089/mcp
```

MCP endpoint (via mcp-gateway, OAuth required by some clients):

```text
http://127.0.0.1:8080/mcp/subscribe-probe
```

Watch server logs:

```bash
docker compose logs -f
```

---

## Result Levels

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

---

## Clients to Verify in Round 2

Only clients that reached Level 1 in Round 1 due to the resource-only server issue:

| Client | Round 1 root cause | Expected improvement |
| --- | --- | --- |
| Codex CLI | No tool surface for agent | tools/list should now return get_review_status |
| OpenCode | tools/list -> "Failed to get tools" | tools/list should succeed |
| Crush | tools/list -> "Method not found" | tools/list should succeed |
| GitHub Copilot CLI | No tool surface for agent | tools/list should return get_review_status; resource subscription likely still inaccessible via agent interface |

Results go in: `results/compatibility-matrix-v2.md`
