import { describe, expect, it } from "vitest";
import { splitSnippetSegments } from "./highlight";

describe("splitSnippetSegments", () => {
  it("returns the whole text unhighlighted when there are no ranges", () => {
    expect(splitSnippetSegments("hello world", [])).toEqual([
      { text: "hello world", highlighted: false },
    ]);
  });

  it("returns an empty array for empty text and no ranges", () => {
    expect(splitSnippetSegments("", [])).toEqual([]);
  });

  it("highlights a single range in the middle", () => {
    expect(splitSnippetSegments("hello world", [{ start: 6, end: 11 }])).toEqual([
      { text: "hello ", highlighted: false },
      { text: "world", highlighted: true },
    ]);
  });

  it("highlights a range at the very start", () => {
    expect(splitSnippetSegments("hello world", [{ start: 0, end: 5 }])).toEqual([
      { text: "hello", highlighted: true },
      { text: " world", highlighted: false },
    ]);
  });

  it("highlights the entire text", () => {
    expect(splitSnippetSegments("hello", [{ start: 0, end: 5 }])).toEqual([
      { text: "hello", highlighted: true },
    ]);
  });

  it("handles multiple non-overlapping ranges", () => {
    expect(
      splitSnippetSegments("the report and the invoice", [
        { start: 4, end: 10 },
        { start: 19, end: 26 },
      ]),
    ).toEqual([
      { text: "the ", highlighted: false },
      { text: "report", highlighted: true },
      { text: " and the ", highlighted: false },
      { text: "invoice", highlighted: true },
    ]);
  });

  it("sorts out-of-order ranges before splitting", () => {
    const result = splitSnippetSegments("the report and the invoice", [
      { start: 19, end: 26 },
      { start: 4, end: 10 },
    ]);
    expect(result.map((s) => s.text)).toEqual(["the ", "report", " and the ", "invoice"]);
  });

  it("merges overlapping ranges into one highlighted segment", () => {
    expect(
      splitSnippetSegments("invoices", [
        { start: 0, end: 7 },
        { start: 2, end: 7 },
      ]),
    ).toEqual([
      { text: "invoice", highlighted: true },
      { text: "s", highlighted: false },
    ]);
  });

  it("clamps a range extending past the end of the text", () => {
    expect(splitSnippetSegments("hello", [{ start: 3, end: 100 }])).toEqual([
      { text: "hel", highlighted: false },
      { text: "lo", highlighted: true },
    ]);
  });

  it("clamps a range starting before zero", () => {
    expect(splitSnippetSegments("hello", [{ start: -5, end: 2 }])).toEqual([
      { text: "he", highlighted: true },
      { text: "llo", highlighted: false },
    ]);
  });

  it("drops a range that is entirely out of bounds", () => {
    expect(splitSnippetSegments("hello", [{ start: 10, end: 20 }])).toEqual([
      { text: "hello", highlighted: false },
    ]);
  });

  it("drops a degenerate range where start equals end", () => {
    expect(splitSnippetSegments("hello", [{ start: 2, end: 2 }])).toEqual([
      { text: "hello", highlighted: false },
    ]);
  });
});
