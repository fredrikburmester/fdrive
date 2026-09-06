import { describe, expect, it } from "vitest";
import { apiClient, pathToHref, queryKeys, segmentsToPath, viewHref } from "./deps";

describe("deps", () => {
  it("re-exports a usable apiClient", () => {
    expect(typeof apiClient.stat).toBe("function");
    expect(typeof apiClient.downloadUrl).toBe("function");
  });

  it("re-exports queryKeys", () => {
    expect(queryKeys.fs.stat("/a")).toEqual(["fs", "stat", "/a"]);
  });

  it("re-exports the path/url helpers", () => {
    expect(segmentsToPath(["a"])).toBe("/a");
    expect(pathToHref("/a")).toBe("/browse/a");
    expect(viewHref("/a")).toBe("/view/a");
  });
});
