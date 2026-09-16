import { ApiClientError, type ApiErrorKind } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { describeApiError, describeCredentialError, isReauthRequired } from "./errors.ts";

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
  "setup_required",
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

describe("describeCredentialError", () => {
  it("shows the server's refusal as a sentence instead of the signed-out message", () => {
    expect(
      describeCredentialError(
        new ApiClientError("unauthorized", "invalid username or password", 401),
      ),
    ).toBe("Invalid username or password.");
    expect(
      describeCredentialError(
        new ApiClientError("unauthorized", "current password is incorrect.", 401),
      ),
    ).toBe("Current password is incorrect.");
  });

  it("falls back to the friendly message for an empty refusal and for other kinds", () => {
    expect(describeCredentialError(new ApiClientError("unauthorized", "", 401))).toBe(
      "You're signed out. Sign in to continue.",
    );
    expect(describeCredentialError(new ApiClientError("rate_limited", "slow down", 429))).toBe(
      "Too many requests. Try again in a moment.",
    );
    expect(describeCredentialError(new Error("network dropped"))).toBe("network dropped");
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
