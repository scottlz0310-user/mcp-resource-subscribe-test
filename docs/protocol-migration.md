# Protocol Migration — MCP `2026-07-28`

This document records the protocol this repository speaks, the versions of the
surrounding services it interoperates with, the order the migration was rolled
out in, and the criteria under which the legacy path was removed.

It answers the documentation items of
[#162](https://github.com/scottlz0310/mcp-resource-subscriber/issues/162) that
[PR #168](https://github.com/scottlz0310/mcp-resource-subscriber/pull/168)
deliberately deferred. Cross-repository tracker:
[scottlz0310/thread-owl#165](https://github.com/scottlz0310/thread-owl/issues/165).

---

## Adopted protocol

This CLI speaks MCP protocol revision **`2026-07-28` only**. Negotiation is
pinned (`versionNegotiation: { mode: { pin: "2026-07-28" } }`, see
[`src/client/protocolNegotiation.ts`](../src/client/protocolNegotiation.ts));
`"auto"` is deliberately not used, because it downgrades to a 2025-era revision
silently and #162 requires that the client never switch mechanisms without
saying so.

What the revision changes for this repository:

| Concern | 2025-era | `2026-07-28` |
|---|---|---|
| Subscribe | `resources/subscribe` RPC | POST `subscriptions/listen`, URIs in `params.notifications.resourceSubscriptions` |
| Confirmation | none — the RPC result was the confirmation | `notifications/subscriptions/acknowledged`, carrying the honored URI filter |
| Update event | `notifications/resources/updated` | unchanged |
| Re-read | `resources/read` | unchanged |
| Unsubscribe | `resources/unsubscribe` RPC | close the stream |
| Session | `Mcp-Session-Id`, stateful | none — stateless, discovery-first |
| Standalone GET SSE | supported | removed; the reference server answers GET / DELETE with `405` |

The SDK moved from `@modelcontextprotocol/sdk` 1.30.0 to
`@modelcontextprotocol/{client,core}` v2 (dependencies) and
`@modelcontextprotocol/{server,node}` v2 (devDependencies). The `latest`
dist-tag of the old `@modelcontextprotocol/sdk` package still points at 1.30.0,
which is the end of the v1 line, so **Renovate will not raise v2 for it** — v2
updates in this repository are applied by hand.

---

## Compatibility matrix

`2026-07-28 since` is the first release of that component that speaks the new
revision — for the endpoints (clients and servers), an older release cannot
interoperate with anything else in this table. The gateway is not an endpoint:
it is protocol-independent, so its entry means the release from which the
transparency contract is *guaranteed by tests*, not the release from which it
became compatible.

| Repository | Role | `2026-07-28` since | Latest release | Legacy `initialize` |
|---|---|---|---|---|
| [mcp-gateway](https://github.com/scottlz0310/mcp-gateway) | transparent proxy | v0.10.0 (contract guaranteed; older releases unverified, not necessarily incompatible) | v0.10.0 | passed through — permanent regression requirement, alongside `Mcp-Session-Id` |
| [thread-owl](https://github.com/scottlz0310/thread-owl) | server | v0.4.0 | v0.4.1 | rejected (`legacy: "reject"`) |
| [review-raven](https://github.com/scottlz0310/review-raven) | server | v0.2.0 (stateless), v0.3.0 (legacy rejected) | v0.3.0 | rejected (`-32022`) |
| **mcp-resource-subscriber** | client (this repo) | v0.6.0 | v0.6.0 | never offered (pinned) |
| [squirrel-notifier](https://github.com/scottlz0310/squirrel-notifier) | downstream consumer of this CLI | `main` (PRs [#246](https://github.com/scottlz0310/squirrel-notifier/pull/246) / [#247](https://github.com/scottlz0310/squirrel-notifier/pull/247)) | v0.6.0 (pre-migration) | n/a |
| [Mcp-Docker](https://github.com/scottlz0310/Mcp-Docker) | integrated E2E environment | — | v2.16.3 | n/a — [#230](https://github.com/scottlz0310/Mcp-Docker/issues/230) open |

Because neither endpoint keeps a fallback, a mismatch between a client and a
server fails loudly in one of two directions:

- **Old client → migrated server**: the server answers the 2025-era
  `initialize` with JSON-RPC error `-32022`.
- **Migrated client → old server**: `server/discover` cannot offer
  `2026-07-28`, and this CLI reports `errorCode: "PROTOCOL_UNSUPPORTED"` with
  exit code `3` and a `recommendedNextAction` telling the operator to upgrade
  the server, or the gateway in front of it.

The gateway is transparent by contract, so it never resolves such a mismatch —
it forwards the failure. That transparency contract (no session minting, no SSE
buffering, keep-alive comment lines preserved, `MCP-Protocol-Version` and
`Mcp-Session-Id` forwarded unchanged in both directions for modern *and* legacy
traffic) is fixed by contract tests in mcp-gateway and specified in its
`docs/mcp-protocol-transparency.md`. Note that the gateway's `Mcp-Session-Id`
pass-through is deliberately permanent: it is a regression requirement so the
gateway can keep routing upstreams that still speak the older protocol. The
gateway never interprets the header itself.

---

## Rollout order

The migration was rolled out **gateway → server → client**.

1. **mcp-gateway** ([#216](https://github.com/scottlz0310/mcp-gateway/issues/216), v0.10.0).
   The gateway only forwards and is protocol-independent, so it was never a
   compatibility blocker. What #216 added was not new-protocol support but
   *proof*: contract tests pinning the behaviours a long-lived
   `subscriptions/listen` stream depends on — no SSE buffering, keep-alive
   comment lines preserved, no session minted or required. Doing this first
   meant that when an endpoint later failed, the gateway was already ruled out
   as the cause.
2. **Servers** — thread-owl
   ([#176](https://github.com/scottlz0310/thread-owl/issues/176), v0.4.0) and
   review-raven ([#111](https://github.com/scottlz0310/review-raven/issues/111),
   v0.2.0; legacy `initialize` rejection in
   [#117](https://github.com/scottlz0310/review-raven/issues/117), v0.3.0).
   For review-raven, statelessness was not a preference: measured against
   go-sdk v1.7.0, the stateful path leaked three sessions per run *and* fell
   back to `2025-11-25`, while the stateless path leaked none and negotiated
   `2026-07-28` correctly.
3. **Clients** — this repository
   ([#162](https://github.com/scottlz0310/mcp-resource-subscriber/issues/162),
   v0.6.0), then squirrel-notifier
   ([#238](https://github.com/scottlz0310/squirrel-notifier/issues/238)), which
   consumes this CLI.

Servers chose `legacy: "reject"` rather than a dual-stack transition, so between
step 2 and step 3 pre-migration clients could not connect at all. That window
opened when thread-owl v0.4.0 shipped and closed when this CLI's v0.6.0 shipped;
squirrel-notifier followed on `main`. The order matters only in that direction —
migrating clients before servers would have produced the same outage from the
other side.

---

## Legacy removal

**The legacy stateful path is not retained at the endpoints — not even as a
transitional compatibility shim.** This was decided on 2026-08-24 on the
cross-repository tracker and applies to every client and server in the matrix
above.

It does **not** apply to the gateway. Being protocol-independent, mcp-gateway
has nothing to retain or remove: it forwards legacy `initialize` and
`Mcp-Session-Id` unchanged, and that pass-through is a permanent regression
requirement rather than a transitional shim. "Legacy removal" below is
therefore about endpoints only.

#165's completion condition reads: *if a legacy fallback is kept, state its
targets, deadline, and removal criteria.* The answer here is that none is kept,
so there is no deadline to track and nothing left to schedule for removal.
Concretely, in this repository the following are gone as of v0.6.0 rather than
deprecated:

- `resources/subscribe` and `resources/unsubscribe` call sites in the probe client
- the `Mcp-Session-Id` session map and the standalone GET SSE endpoint in the
  reference server (`src/server/`)
- the `subscribed` / `unsubscribed` output fields, replaced by
  `listenAcknowledged` / `honoredUris` / `closeReason`

The reasons for keeping no fallback:

- `"auto"` negotiation downgrades silently, which is exactly the behaviour #162
  set out to prevent.
- A stateful fallback would have to be reachable to be useful, which means
  keeping the session machinery whose leaks motivated the stateless move.
- Two live paths would double the contract-test surface for a compatibility
  mode that has no remaining consumer — every client in the matrix is migrated.

What replaces the fallback is an explicit failure contract, covered by contract
tests: `PROTOCOL_UNSUPPORTED` on the client side, `-32022` on the server side,
and `SUBSCRIPTION_NOT_HONORED` when a server acknowledges a
`subscriptions/listen` without honoring the requested URI, so the client fails
instead of waiting for a notification that will never arrive.

---

## Open items

These are tracked outside this repository and do not block anything here:

- [Mcp-Docker#230](https://github.com/scottlz0310/Mcp-Docker/issues/230) — the
  cross-repository E2E / conformance suite for `2026-07-28` is not implemented
  yet. Its acceptance criteria live in mcp-gateway's
  `docs/mcp-protocol-transparency.md`.
- [thread-owl#176](https://github.com/scottlz0310/thread-owl/issues/176) and
  [#117](https://github.com/scottlz0310/thread-owl/issues/117) remain open
  pending long-running verification against a real deployment.
- squirrel-notifier's migration is merged on `main` but not yet released; its
  latest tag (v0.6.0) still predates the migration.
- [go-sdk#1169](https://github.com/modelcontextprotocol/go-sdk/issues/1169) — an
  upstream Go client bug found while migrating review-raven, awaiting upstream
  PR #1170. Go-side only; this repository is unaffected.

---

## Historical material

The compatibility matrices under [`results/`](../results) and the verification
guides in this directory were produced during the 2025-era compatibility spike.
They describe `resources/subscribe` / `resources/unsubscribe` flows that no
longer exist, and are kept as a record rather than as instructions. The flow in
use today is documented in the README's
[Expected Client Behavior](../README.md#expected-client-behavior).
