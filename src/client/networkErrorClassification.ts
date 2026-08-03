/**
 * Classifies low-level network failures (TLS trust, DNS, connection refused)
 * that Node's fetch (undici) surfaces as a flat `TypeError: fetch failed`
 * with the real cause nested in `error.cause`. Without this, all three are
 * indistinguishable in CLI output (see #120).
 */

const TLS_CAUSE_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface NetworkErrorClassification {
  errorCode: "TLS_CERT_UNTRUSTED" | "DNS_LOOKUP_FAILED" | "CONNECTION_REFUSED";
  recommendedNextAction: string;
}

/** Walks `error.cause` chains for matching TLS/network error codes. */
function findCauseCode(error: unknown, depth = 5): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < depth && current; i++) {
    if (typeof current === "object" && "code" in current && typeof (current as { code: unknown }).code === "string") {
      const code = (current as { code: string }).code;
      if (TLS_CAUSE_CODES.has(code) || code === "ENOTFOUND" || code === "ECONNREFUSED") {
        return code;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function classifyNetworkError(error: unknown): NetworkErrorClassification | null {
  const code = findCauseCode(error);
  if (code === undefined) {
    return null;
  }

  if (TLS_CAUSE_CODES.has(code)) {
    return {
      errorCode: "TLS_CERT_UNTRUSTED",
      recommendedNextAction:
        "The server's TLS certificate is not trusted. If it uses a local CA (e.g. mkcert), set NODE_EXTRA_CA_CERTS to the CA root (mkcert: $(mkcert -CAROOT)/rootCA.pem), or run with NODE_USE_SYSTEM_CA=1 if the CA is in the OS trust store.",
    };
  }
  if (code === "ENOTFOUND") {
    return {
      errorCode: "DNS_LOOKUP_FAILED",
      recommendedNextAction: "The hostname in --url could not be resolved. Check for typos and DNS connectivity.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      errorCode: "CONNECTION_REFUSED",
      recommendedNextAction:
        "The server refused the connection. Check that --url's host and port are correct and the server is running.",
    };
  }
  return null;
}
