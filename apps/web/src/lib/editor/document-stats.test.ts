import { describe, expect, it } from "vitest";
import { computeDocumentStats } from "./document-stats";

describe("computeDocumentStats", () => {
  it("reports line 1, column 1 for an empty document", () => {
    expect(computeDocumentStats("", 0)).toEqual({ line: 1, column: 1, length: 0 });
  });

  it("reports the column mid-line", () => {
    expect(computeDocumentStats("hello world", 5)).toEqual({ line: 1, column: 6, length: 11 });
  });

  it("counts lines up to the cursor", () => {
    const text = "one\ntwo\nthree";
    // cursor right after the second newline, start of "three"
    expect(computeDocumentStats(text, 8)).toEqual({ line: 3, column: 1, length: text.length });
  });

  it("reports the column right before a newline", () => {
    const text = "one\ntwo";
    expect(computeDocumentStats(text, 3)).toEqual({ line: 1, column: 4, length: text.length });
  });

  it("clamps a negative offset to the start", () => {
    expect(computeDocumentStats("abc", -5)).toEqual({ line: 1, column: 1, length: 3 });
  });

  it("clamps an offset beyond the document to the end", () => {
    expect(computeDocumentStats("abc", 999)).toEqual({ line: 1, column: 4, length: 3 });
  });
});
