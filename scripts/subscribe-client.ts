import { extractRecommendedAction, runSubscribeProbe } from "../src/client/probeClient.js";
import { REVIEW_STATUS_URI } from "../src/server/resourceState.js";

interface CliOptions {
  url: string | null;
  uri: string;
  timeoutMs: number;
}

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

function parseOptions(): CliOptions {
  const url = readOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  const uri = readOption("uri") ?? process.env.MCP_PROBE_URI ?? REVIEW_STATUS_URI;
  const timeoutRaw = readOption("timeout-ms") ?? process.env.MCP_PROBE_TIMEOUT_MS ?? "15000";
  const timeoutMs = Number(timeoutRaw);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutRaw}`);
  }

  return { url, uri, timeoutMs };
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

try {
  const options = parseOptions();

  if (options.url === null) {
    console.log("error-code SERVER_URL_UNKNOWN");
    console.log("phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN");
    process.exitCode = 1;
  } else {
    const result = await runSubscribeProbe({ url: options.url, uri: options.uri, timeoutMs: options.timeoutMs });
    printResult(result, options.url, options.uri);
    if (result.errorCode) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`subscribe-probe failed: ${message}`);
  console.log("error-code INTERNAL_ERROR");
  console.log("phase-summary route=failed url=unknown error-code=INTERNAL_ERROR");
  process.exitCode = 1;
}
