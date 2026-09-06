import { describe, expect, it } from "vitest";
import { ApiHttpError, toApiError } from "./errors";

describe("ApiHttpError", () => {
  it("carries the kind, message, and details", () => {
    const error = new ApiHttpError("conflict", "already exists", { path: "/a" });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiHttpError");
    expect(error.kind).toBe("conflict");
    expect(error.message).toBe("already exists");
    expect(error.details).toEqual({ path: "/a" });
  });

  it("leaves details undefined when not provided", () => {
    const error = new ApiHttpError("not_found", "missing");

    expect(error.details).toBeUndefined();
  });
});

describe("toApiError", () => {
  it("builds a minimal payload with no requestId or details", () => {
    expect(toApiError("bad_request", "invalid")).toEqual({
      error: { kind: "bad_request", message: "invalid" },
    });
  });

  it("includes requestId when provided", () => {
    expect(toApiError("bad_request", "invalid", "req-1")).toEqual({
      error: { kind: "bad_request", message: "invalid", requestId: "req-1" },
    });
  });

  it("includes details when provided", () => {
    expect(toApiError("bad_request", "invalid", undefined, { field: "x" })).toEqual({
      error: { kind: "bad_request", message: "invalid", details: { field: "x" } },
    });
  });

  it("includes both requestId and details when provided", () => {
    expect(toApiError("bad_request", "invalid", "req-1", { field: "x" })).toEqual({
      error: {
        kind: "bad_request",
        message: "invalid",
        requestId: "req-1",
        details: { field: "x" },
      },
    });
  });
});
