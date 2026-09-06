import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { summarizeSelection } from "./selection";

function entry(size: number): FsEntry {
  return {
    name: "f",
    path: "/f",
    kind: "file",
    size,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

describe("summarizeSelection", () => {
  it("returns zero count and size for an empty selection", () => {
    expect(summarizeSelection([])).toEqual({ count: 0, totalSize: 0 });
  });

  it("counts entries and sums their sizes", () => {
    expect(summarizeSelection([entry(100), entry(250), entry(50)])).toEqual({
      count: 3,
      totalSize: 400,
    });
  });

  it("handles a single entry", () => {
    expect(summarizeSelection([entry(42)])).toEqual({ count: 1, totalSize: 42 });
  });
});
