import { ApiClientError, type ApiErrorKind } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { describeApiError, isReauthRequired } from "./errors.js";

const ALL_KINDS: ApiErrorKind[] = [
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
];

describe("describeApiError", () => {
  it("returns a friendly message for every known ApiClientError kind", () => {
    for (const kind of ALL_KINDS) {
      const err = new ApiClientError(kind, "raw server message", 500);
      expect(describeApiError(err)).toEqual(expect.any(String));
      expect(describeApiError(err).length).toBeGreaterThan(0);
    }
  });

  it("returns the message of a plain Error when it has one", () => {
    expect(describeApiError(new Error("network dropped"))).toBe("network dropped");
  });

  it("falls back to a generic message for an Error with an empty message", () => {
    expect(describeApiError(new Error(""))).toBe("Something went wrong. Please try again.");
  });

  it("falls back to a generic message for a non-Error value", () => {
    expect(describeApiError("nope")).toBe("Something went wrong. Please try again.");
    expect(describeApiError(undefined)).toBe("Something went wrong. Please try again.");
  });
});

describe("isReauthRequired", () => {
  it("is true for unauthorized", () => {
    expect(isReauthRequired(new ApiClientError("unauthorized", "x", 401))).toBe(true);
  });

  it("is true for reauth_required", () => {
    expect(isReauthRequired(new ApiClientError("reauth_required", "x", 401))).toBe(true);
  });

  it("is false for other ApiClientError kinds", () => {
    expect(isReauthRequired(new ApiClientError("forbidden", "x", 403))).toBe(false);
  });

  it("is false for a non-ApiClientError value", () => {
    expect(isReauthRequired(new Error("boom"))).toBe(false);
  });
});
