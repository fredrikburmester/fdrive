import { describe, expect, it } from "vitest";
import { CoreError, isCoreError } from "./errors.js";

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
