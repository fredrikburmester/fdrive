import { describe, expect, it } from "vitest";
import {
  extractDetail,
  mapStatusToKind,
  SftpgoError,
  toNetworkError,
  toSftpgoError,
} from "./errors.js";

describe("mapStatusToKind", () => {
  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [599, "server"],
  ] as const)("maps %i to %s", (status, kind) => {
    expect(mapStatusToKind(status)).toBe(kind);
  });

  it("maps an unrecognized status to unexpected", () => {
    expect(mapStatusToKind(302)).toBe("unexpected");
    expect(mapStatusToKind(418)).toBe("unexpected");
  });
});

describe("extractDetail", () => {
  it("returns null for an empty body", () => {
    expect(extractDetail("")).toBeNull();
  });

  it("prefers a non-empty message field", () => {
    expect(extractDetail('{"message":"boom","error":"other"}')).toBe("boom");
  });

  it("falls back to the error field when message is empty", () => {
    expect(extractDetail('{"message":"","error":"boom"}')).toBe("boom");
  });

  it("falls back to raw text when the body is not JSON", () => {
    expect(extractDetail("plain text body")).toBe("plain text body");
  });

  it("falls back to raw text when the JSON body has neither field populated", () => {
    expect(extractDetail('{"message":"","error":""}')).toBe('{"message":"","error":""}');
  });

  it("falls back to raw text when the JSON body is not an object", () => {
    expect(extractDetail("[1,2,3]")).toBe("[1,2,3]");
  });

  it("truncates long detail text to 500 characters", () => {
    const long = "x".repeat(600);
    const detail = extractDetail(long);
    expect(detail).toHaveLength(500);
  });
});

describe("toSftpgoError", () => {
  it("builds an error from a JSON error response", async () => {
    const response = new Response(JSON.stringify({ message: "", error: "Permission denied" }), {
      status: 403,
    });
    const error = await toSftpgoError(response);
    expect(error).toBeInstanceOf(SftpgoError);
    expect(error.kind).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.detail).toBe("Permission denied");
  });

  it("handles a response body that cannot be read", async () => {
    const response = new Response("already consumed", { status: 500 });
    // Consume the body so the second read inside toSftpgoError fails and the catch branch runs.
    await response.text();
    const error = await toSftpgoError(response);
    expect(error.kind).toBe("server");
    expect(error.detail).toBeNull();
  });
});

describe("toNetworkError", () => {
  it("wraps an Error instance", () => {
    const error = toNetworkError(new Error("boom"));
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.message).toContain("boom");
  });

  it("wraps a non-Error thrown value", () => {
    const error = toNetworkError("boom");
    expect(error.kind).toBe("network");
    expect(error.message).toContain("boom");
  });
});

describe("SftpgoError", () => {
  it("carries kind, status, and detail", () => {
    const error = new SftpgoError("failed", "conflict", 409, "already exists");
    expect(error.name).toBe("SftpgoError");
    expect(error.message).toBe("failed");
    expect(error.kind).toBe("conflict");
    expect(error.status).toBe(409);
    expect(error.detail).toBe("already exists");
  });
});
