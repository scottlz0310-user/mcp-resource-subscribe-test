/**
 * E2E verification tests against a real external MCP server.
 *
 * These tests are skipped unless MCP_E2E_URL is set in the environment.
 *
 * Example usage (against copilot-review-mcp behind mcp-gateway):
 *   MCP_E2E_URL=http://127.0.0.1:8080/mcp/copilot-review \
 *   MCP_E2E_TOKEN=$(gh auth token) \
 *   MCP_E2E_WATCH_ID=<watch_id> \
 *   pnpm vitest run test/e2e.test.ts
 *
 * Levels of verification:
 *   Level 1 – server reachable, capabilities advertise subscribe:true (always)
 *   Level 2 – resources/list works, RESOURCE_NOT_FOUND returned gracefully
 *   Level 3 – full subscribe→notify→re-read flow (requires MCP_E2E_WATCH_ID)
 */
import { describe, expect, it } from "vitest";
import { runSubscribeProbe } from "../src/client/probeClient.js";

const E2E_URL = process.env.MCP_E2E_URL;
const E2E_TOKEN = process.env.MCP_E2E_TOKEN;
const E2E_WATCH_ID = process.env.MCP_E2E_WATCH_ID;

const requestHeaders = E2E_TOKEN ? { Authorization: `Bearer ${E2E_TOKEN}` } : undefined;

describe.skipIf(!E2E_URL)("E2E: external MCP server (copilot-review-mcp)", () => {
  const url = E2E_URL as string;

  it("Level 1: server is reachable and advertises resources.subscribe=true", async () => {
    // Use a nonexistent URI to trigger RESOURCE_NOT_FOUND — we only care about capabilities here
    const result = await runSubscribeProbe({
      url,
      uri: "copilot-review://watch/__connectivity_check__",
      timeoutMs: 10_000,
      requestHeaders,
    });

    expect(result.capabilities).toMatchObject({ subscribe: true });
    // RESOURCE_NOT_FOUND confirms the probe completed the capabilities handshake
    // before failing on the list check — i.e. the server was reachable.
    expect(result.errorCode).toBe("RESOURCE_NOT_FOUND");
  }, 15_000);

  it("Level 2: RESOURCE_NOT_FOUND returned gracefully for unknown URI", async () => {
    const result = await runSubscribeProbe({
      url,
      uri: "copilot-review://watch/__does_not_exist__",
      timeoutMs: 10_000,
      requestHeaders,
    });

    expect(result.resourceFound).toBe(false);
    expect(result.errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(result.listenAcknowledged).toBe(false);
  }, 15_000);

  it.skipIf(!E2E_WATCH_ID)(
    "Level 3: full subscribe→notify→re-read flow against real watch",
    async () => {
      // NOTE: These assertions have not yet been verified against the real
      // copilot-review-mcp server. They represent the expected happy-path
      // contract. If they fail, adjust after confirming actual server behavior.
      const uri = `copilot-review://watch/${E2E_WATCH_ID}`;
      const result = await runSubscribeProbe({
        url,
        uri,
        timeoutMs: 900_000, // 15 minutes — Copilot review may take time
        requestHeaders,
        skipResourceListCheck: true, // copilot-review-mcp does not list dynamic watch URIs
      });

      expect(result.resourceFound).toBe(true);
      expect(result.listenAcknowledged).toBe(true);
      expect(result.honoredUris).toContain(uri);
      expect(result.route).toBe("subscription");
      expect(result.notificationUri).toBe(uri);
      expect(result.finalText).toBeTruthy();
      expect(result.closeReason).toBe("local");
      expect(result.errorCode).toBeNull();
    },
    910_000,
  );
});
