import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

describe("queryKeys.fs.list", () => {
  it("builds the fs list query key for a path", () => {
    expect(queryKeys.fs.list("/a/b")).toEqual(["fs", "list", "/a/b"]);
  });
});
