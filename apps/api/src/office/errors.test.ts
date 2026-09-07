import { StorageError, type StorageErrorKind } from "@fdrive/core";
import { expect, it } from "vitest";
import { officeErrorResponse, requireMatchingLock, WopiError } from "./errors.ts";

it.each<[StorageErrorKind, number]>([
  ["unauthorized", 401],
  ["forbidden", 403],
  ["not_found", 404],
  ["conflict", 409],
  ["payload_too_large", 413],
  ["bad_request", 400],
  ["rate_limited", 429],
  ["upstream_unavailable", 502],
  ["internal", 500],
])("maps %s to WOPI %s", (kind, status) => {
  const response = officeErrorResponse(new StorageError(kind, "private"));
  expect(response.status).toBe(status);
  if (status === 409) expect(response.headers.get("X-WOPI-Lock")).toBe("");
});
it("maps host errors and unexpected failures without detail", () => {
  expect(
    officeErrorResponse(
      new WopiError(400, { "X-WOPI-InvalidFileNameError": "Invalid" }),
    ).headers.get("X-WOPI-InvalidFileNameError"),
  ).toBe("Invalid");
  expect(officeErrorResponse(new Error("private")).status).toBe(500);
});
it("permits absent locks only for operations allowing it", () => {
  expect(() => requireMatchingLock(null, undefined)).not.toThrow();
  expect(() => requireMatchingLock("x", "x", false)).not.toThrow();
  expect(() => requireMatchingLock("x", "y")).toThrow();
  expect(() => requireMatchingLock(null, undefined, false)).toThrow();
});
