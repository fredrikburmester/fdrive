import { describe, expect, it } from "vitest";
import { SftpgoError } from "./errors.js";
import { assertValidPath, dirnameOf, joinPath, normalizePath } from "./path.js";

describe("assertValidPath", () => {
  it("accepts an absolute path", () => {
    expect(() => assertValidPath("/a/b")).not.toThrow();
  });

  it("accepts the root path", () => {
    expect(() => assertValidPath("/")).not.toThrow();
  });

  it("rejects a path that does not start with /", () => {
    expect(() => assertValidPath("a/b")).toThrow(SftpgoError);
    try {
      assertValidPath("a/b");
      throw new Error("expected assertValidPath to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SftpgoError);
      expect((error as SftpgoError).kind).toBe("bad_request");
      expect((error as SftpgoError).status).toBeNull();
    }
  });

  it("rejects a path containing a NUL byte", () => {
    expect(() => assertValidPath("/a\0b")).toThrow(SftpgoError);
  });

  it("rejects an empty path", () => {
    expect(() => assertValidPath("")).toThrow(SftpgoError);
  });
});

describe("dirnameOf", () => {
  it("returns / for the root", () => {
    expect(dirnameOf("/")).toBe("/");
  });

  it("returns the parent of a top-level path", () => {
    expect(dirnameOf("/a")).toBe("/");
  });

  it("returns the parent of a nested path", () => {
    expect(dirnameOf("/a/b/c")).toBe("/a/b");
  });

  it("ignores a trailing slash", () => {
    expect(dirnameOf("/a/b/")).toBe("/a");
  });
});

describe("joinPath", () => {
  it("joins a segment onto the root", () => {
    expect(joinPath("/", "a")).toBe("/a");
  });

  it("joins a segment onto a nested directory", () => {
    expect(joinPath("/a/b", "c")).toBe("/a/b/c");
  });
});

describe("normalizePath", () => {
  it("strips a trailing slash", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
  });

  it("keeps the root path as is", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("maps an empty string to the root", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("leaves a path with no trailing slash untouched", () => {
    expect(normalizePath("/a/b")).toBe("/a/b");
  });
});
