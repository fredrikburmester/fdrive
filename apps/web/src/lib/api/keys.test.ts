import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys.ts";

describe("queryKeys", () => {
  it("auth.me() builds a stable key", () => {
    expect(queryKeys.auth.me()).toEqual(["auth", "me"]);
  });

  it("fs.list(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.list("/docs")).toEqual(["fs", "list", "/docs"]);
  });

  it("fs.stat(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.stat("/docs/file.txt")).toEqual(["fs", "stat", "/docs/file.txt"]);
  });
});
