import { describe, expect, it } from "vitest";
import { ApiError, ApiErrorKind, statusForKind } from "./error";

describe("ApiErrorKind", () => {
  it("accepts every documented kind", () => {
    const kinds = [
      "bad_request",
      "unauthorized",
      "reauth_required",
      "forbidden",
      "not_found",
      "conflict",
      "payload_too_large",
      "rate_limited",
      "internal",
      "upstream_unavailable",
      "setup_required",
    ];

    for (const kind of kinds) {
      expect(ApiErrorKind.safeParse(kind).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(ApiErrorKind.safeParse("teapot").success).toBe(false);
  });
});

describe("ApiError", () => {
  it("parses a minimal valid payload", () => {
    const payload = {
      error: {
        kind: "not_found",
        message: "file not found",
      },
    };

    expect(ApiError.parse(payload)).toEqual(payload);
  });

  it("parses a payload with requestId and details", () => {
    const payload = {
      error: {
        kind: "bad_request",
        message: "invalid path",
        requestId: "req-123",
        details: { field: "path" },
      },
    };

    expect(ApiError.parse(payload)).toEqual(payload);
  });

  it("rejects an invalid kind", () => {
    const payload = {
      error: {
        kind: "teapot",
        message: "nope",
      },
    };

    expect(ApiError.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing message", () => {
    const payload = {
      error: {
        kind: "internal",
      },
    };

    expect(ApiError.safeParse(payload).success).toBe(false);
  });

  it("rejects details with non-string keys values that are not records", () => {
    const payload = {
      error: {
        kind: "internal",
        message: "boom",
        details: "not-a-record",
      },
    };

    expect(ApiError.safeParse(payload).success).toBe(false);
  });
});

describe("statusForKind", () => {
  it("maps every kind to its documented status code", () => {
    expect(statusForKind("bad_request")).toBe(400);
    expect(statusForKind("unauthorized")).toBe(401);
    expect(statusForKind("reauth_required")).toBe(401);
    expect(statusForKind("forbidden")).toBe(403);
    expect(statusForKind("not_found")).toBe(404);
    expect(statusForKind("conflict")).toBe(409);
    expect(statusForKind("payload_too_large")).toBe(413);
    expect(statusForKind("rate_limited")).toBe(429);
    expect(statusForKind("internal")).toBe(500);
    expect(statusForKind("upstream_unavailable")).toBe(502);
    expect(statusForKind("setup_required")).toBe(503);
  });
});
