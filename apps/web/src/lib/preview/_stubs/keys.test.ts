import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

describe("queryKeys.fs", () => {
  it("builds a list key from a path", () => {
    expect(queryKeys.fs.list("/docs")).toEqual(["fs", "list", "/docs"]);
  });

  it("builds a stat key from a path", () => {
    expect(queryKeys.fs.stat("/docs/report.pdf")).toEqual(["fs", "stat", "/docs/report.pdf"]);
  });
});
