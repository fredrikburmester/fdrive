import { StorageError } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { describeSdkError, kindForSdkError, toStorageError } from "./errors.js";

function sdkError(name: string, status?: number, message = `${name} happened`) {
  return Object.assign(new Error(message), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });
}

describe("describeSdkError", () => {
  it("reads code, status and message, tolerating non-errors", () => {
    expect(describeSdkError(sdkError("NoSuchKey", 404))).toEqual({
      code: "NoSuchKey",
      status: 404,
      message: "NoSuchKey happened",
    });
    expect(describeSdkError("boom")).toEqual({ code: null, status: null, message: "boom" });
    expect(describeSdkError({ name: "", $metadata: { httpStatusCode: "x" } })).toMatchObject({
      code: null,
      status: null,
    });
  });
});

describe("kindForSdkError", () => {
  it.each([
    ["NoSuchKey", 404, "not_found"],
    ["NotFound", 404, "not_found"],
    ["AccessDenied", 403, "forbidden"],
    ["InvalidAccessKeyId", 403, "unauthorized"],
    ["SignatureDoesNotMatch", 403, "unauthorized"],
    ["PreconditionFailed", 412, "conflict"],
    ["EntityTooLarge", 400, "payload_too_large"],
    ["SlowDown", 503, "rate_limited"],
    ["InvalidRequest", 400, "bad_request"],
    ["NoSuchBucket", 404, "upstream_unavailable"],
    ["PermanentRedirect", 301, "upstream_unavailable"],
    ["InternalError", 500, "upstream_unavailable"],
  ])("maps the %s code", (code, status, kind) => {
    expect(kindForSdkError(sdkError(code, status))).toBe(kind);
  });

  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [412, "conflict"],
    [413, "payload_too_large"],
    [416, "bad_request"],
    [429, "rate_limited"],
    [302, "upstream_unavailable"],
    [502, "upstream_unavailable"],
    [418, "internal"],
  ])("falls back to status %s", (status, kind) => {
    expect(kindForSdkError(sdkError("SomethingElse", status))).toBe(kind);
  });

  it("treats aborts, timeouts and rejected fetches as the upstream being unavailable", () => {
    expect(kindForSdkError(sdkError("AbortError"))).toBe("upstream_unavailable");
    expect(kindForSdkError(sdkError("TimeoutError"))).toBe("upstream_unavailable");
    expect(kindForSdkError(new TypeError("fetch failed"))).toBe("upstream_unavailable");
    expect(kindForSdkError(new Error("plain"))).toBe("upstream_unavailable");
    expect(kindForSdkError("string")).toBe("upstream_unavailable");
    expect(kindForSdkError(sdkError("Mystery"))).toBe("internal");
  });
});

describe("toStorageError", () => {
  it("passes a StorageError through", () => {
    const original = new StorageError("conflict", "x");
    expect(toStorageError(original)).toBe(original);
  });

  it("keeps code, status, path and a bounded detail", () => {
    const error = toStorageError(
      sdkError("NoSuchKey", 404, `  spaced\n\nmessage ${"x".repeat(600)}`),
      "/a",
    );
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("S3 request failed: NoSuchKey");
    expect(error.details).toMatchObject({ code: "NoSuchKey", status: 404, path: "/a" });
    expect(String(error.details?.detail)).toHaveLength(500);
    expect(String(error.details?.detail).startsWith("spaced message")).toBe(true);
  });

  it("never repeats a signature error's message, which names the access key", () => {
    const error = toStorageError(
      sdkError("SignatureDoesNotMatch", 403, "String to sign: AWS4 alice-key"),
    );
    expect(error.kind).toBe("unauthorized");
    expect(error.details?.detail).toBe("the access key or secret was refused");
    expect(JSON.stringify(error.details)).not.toContain("alice-key");
  });

  it("describes a rejection without code or status", () => {
    expect(toStorageError(new TypeError("fetch failed")).message).toBe(
      "S3 request failed: TypeError",
    );
    const bare = toStorageError({ $metadata: { httpStatusCode: 502 }, message: "" });
    expect(bare.message).toBe("S3 request failed: status 502");
    expect(bare.details).toEqual({ status: 502 });
    expect(toStorageError({}).message).toBe("S3 request failed: request failed");
  });
});
