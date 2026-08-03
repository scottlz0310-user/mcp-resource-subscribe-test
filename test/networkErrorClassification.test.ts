import { describe, expect, it } from "vitest";
import { classifyNetworkError } from "../src/client/networkErrorClassification.js";

// Real error shapes captured from Node's fetch (undici): `TypeError: fetch failed`
// with the actual errno/TLS error nested one level down in `.cause`.
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

describe("classifyNetworkError", () => {
  it.each([
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["CERT_NOT_YET_VALID", "certificate is not yet valid"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
  ])("classifies TLS cause code %s as TLS_CERT_UNTRUSTED", (code, message) => {
    const result = classifyNetworkError(fetchFailed(Object.assign(new Error(message), { code })));

    expect(result).not.toBeNull();
    expect(result?.errorCode).toBe("TLS_CERT_UNTRUSTED");
    expect(result?.recommendedNextAction).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("classifies ENOTFOUND as DNS_LOOKUP_FAILED", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" });
    const result = classifyNetworkError(fetchFailed(cause));

    expect(result?.errorCode).toBe("DNS_LOOKUP_FAILED");
    expect(result?.recommendedNextAction).toContain("hostname");
  });

  it("classifies ECONNREFUSED as CONNECTION_REFUSED", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const result = classifyNetworkError(fetchFailed(cause));

    expect(result?.errorCode).toBe("CONNECTION_REFUSED");
    expect(result?.recommendedNextAction).toContain("--url");
  });

  it("walks nested cause chains to find the errno code", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const wrapped = new Error("wrapped", { cause: root });
    const result = classifyNetworkError(fetchFailed(wrapped));

    expect(result?.errorCode).toBe("CONNECTION_REFUSED");
  });

  it("walks cause chain even if outer error has an unrelated code like ERR_FETCH_FAILED", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const fetchErr = Object.assign(new TypeError("fetch failed", { cause: root }), { code: "ERR_FETCH_FAILED" });
    const result = classifyNetworkError(fetchErr);

    expect(result?.errorCode).toBe("CONNECTION_REFUSED");
  });

  it("returns null for an unrelated error code", () => {
    const cause = Object.assign(new Error("something else"), { code: "EPIPE" });
    expect(classifyNetworkError(fetchFailed(cause))).toBeNull();
  });

  it("returns null when there is no cause code at all", () => {
    expect(classifyNetworkError(new Error("plain error"))).toBeNull();
    expect(classifyNetworkError("not an error")).toBeNull();
    expect(classifyNetworkError(null)).toBeNull();
  });
});
