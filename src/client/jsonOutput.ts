import { extractRecommendedAction, type SubscribeProbeResult } from "./probeClient.js";

export interface JsonOutput {
  route: string;
  serverUrl: string | null;
  resourceUri: string;
  listenAcknowledged: boolean;
  honoredUris: string[];
  notificationReceived: boolean;
  notificationCount: number;
  closeReason: string | null;
  errorCode: string | null;
  initialText: string | null;
  finalText: string | null;
  recommendedNextAction: string | null;
}

export function buildJsonOutput(result: SubscribeProbeResult, serverUrl: string, resourceUri: string): JsonOutput {
  return {
    route: result.route,
    serverUrl,
    resourceUri,
    listenAcknowledged: result.listenAcknowledged,
    honoredUris: result.honoredUris,
    notificationReceived: result.route === "subscription",
    notificationCount: result.notificationCount,
    closeReason: result.closeReason,
    errorCode: result.errorCode,
    initialText: result.initialText || null,
    finalText: result.finalText || null,
    recommendedNextAction: extractRecommendedAction(result.finalText),
  };
}

export function buildErrorJsonOutput(
  errorCode: string,
  serverUrl: string | null,
  resourceUri: string,
  recommendedNextAction: string | null = null,
): JsonOutput {
  return {
    route: "failed",
    serverUrl,
    resourceUri,
    listenAcknowledged: false,
    honoredUris: [],
    notificationReceived: false,
    notificationCount: 0,
    closeReason: null,
    errorCode,
    initialText: null,
    finalText: null,
    recommendedNextAction,
  };
}
