import { describe, expect, it } from "vitest";
import { highlightRanges } from "./snippets.ts";

describe("highlightRanges", () => {
  it("returns an empty array when there are no words", () => {
    expect(highlightRanges("some text", [])).toEqual([]);
  });

  it("returns an empty array when words are blank", () => {
    expect(highlightRanges("some text", ["", "   "])).toEqual([]);
  });

  it("finds a single occurrence of one word", () => {
    expect(highlightRanges("the invoice is due", ["invoice"])).toEqual([{ start: 4, end: 11 }]);
  });

  it("is case-insensitive", () => {
    expect(highlightRanges("The Invoice is due", ["invoice"])).toEqual([{ start: 4, end: 11 }]);
  });

  it("finds multiple occurrences of the same word", () => {
    expect(highlightRanges("cat cat cat", ["cat"])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("finds occurrences of multiple distinct words, sorted by position", () => {
    expect(highlightRanges("the report and the invoice", ["invoice", "report"])).toEqual([
      { start: 4, end: 10 },
      { start: 19, end: 26 },
    ]);
  });

  it("merges overlapping ranges from substring words", () => {
    // "invoice" matches [0,7), "voice" matches [2,7): fully overlapping.
    expect(highlightRanges("invoices", ["invoice", "voice"])).toEqual([{ start: 0, end: 7 }]);
  });

  it("orders ranges with the same start by end when merging", () => {
    // "cat" matches [0,3) and "catalog" matches [0,7): same start, different
    // end, exercising the sort's tie-break on end position.
    expect(highlightRanges("catalog", ["cat", "catalog"])).toEqual([{ start: 0, end: 7 }]);
  });

  it("merges touching ranges", () => {
    expect(highlightRanges("catdog", ["cat", "dog"])).toEqual([{ start: 0, end: 6 }]);
  });

  it("escapes regex metacharacters in words", () => {
    expect(highlightRanges("cost: $1.50 (tax incl.)", ["$1.50"])).toEqual([{ start: 6, end: 11 }]);
  });

  it("returns an empty array when no word matches", () => {
    expect(highlightRanges("nothing here", ["invoice"])).toEqual([]);
  });

  it("ignores blank words mixed with real ones", () => {
    expect(highlightRanges("the invoice", ["", "invoice"])).toEqual([{ start: 4, end: 11 }]);
  });
});
