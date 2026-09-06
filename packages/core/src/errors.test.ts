import { describe, expect, it } from "vitest";
import { CoreError, isCoreError, isStorageError, StorageError } from "./errors.ts";

describe("CoreError", () => {
  it("carries a kind and message", () => {
    const error = new CoreError("invalid_path", "bad path");

    expect(error.kind).toBe("invalid_path");
    expect(error.message).toBe("bad path");
    expect(error.name).toBe("CoreError");
  });

  it("has no details when none are given", () => {
    const error = new CoreError("invalid_argument", "bad argument");

    expect(error.details).toBeUndefined();
  });

  it("carries details when given", () => {
    const error = new CoreError("out_of_scope", "outside scope", { path: "/etc" });

    expect(error.details).toEqual({ path: "/etc" });
  });

  it("is an instance of Error and of CoreError", () => {
    const error = new CoreError("invalid_template", "bad template");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CoreError);
  });
});

describe("isCoreError", () => {
  it("returns true for a CoreError", () => {
    expect(isCoreError(new CoreError("invalid_path", "x"))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isCoreError(new Error("x"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isCoreError("not an error")).toBe(false);
    expect(isCoreError(undefined)).toBe(false);
    expect(isCoreError(null)).toBe(false);
  });
});

describe("StorageError", () => {
  it("carries a kind and message", () => {
    const error = new StorageError("not_found", "missing");

    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("missing");
    expect(error.name).toBe("StorageError");
  });

  it("has no cause or details when none are given", () => {
    const error = new StorageError("internal", "boom");

    expect(error.cause).toBeUndefined();
    expect(error.details).toBeUndefined();
  });

  it("carries a cause and details when given", () => {
    const cause = new Error("upstream failure");
    const error = new StorageError("upstream_unavailable", "unavailable", {
      cause,
      details: { path: "/a" },
    });

    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ path: "/a" });
  });

  it("is an instance of Error and of StorageError", () => {
    const error = new StorageError("forbidden", "nope");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StorageError);
  });
});

describe("isStorageError", () => {
  it("returns true for a StorageError", () => {
    expect(isStorageError(new StorageError("not_found", "x"))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isStorageError(new Error("x"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isStorageError("not an error")).toBe(false);
    expect(isStorageError(undefined)).toBe(false);
    expect(isStorageError(null)).toBe(false);
  });
});
