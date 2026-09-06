import { describe, expect, it } from "vitest";
import { queryWords, toPrefixTsQuery } from "./query.ts";

describe("toPrefixTsQuery", () => {
  it("builds a prefix expression for a single word", () => {
    expect(toPrefixTsQuery("invoice")).toBe("invoice:*");
  });

  it("joins multiple words with |", () => {
    expect(toPrefixTsQuery("invoice report")).toBe("invoice:*|report:*");
  });

  it("strips punctuation from tokens", () => {
    expect(toPrefixTsQuery("invoice, report!")).toBe("invoice:*|report:*");
  });

  it("drops tokens shorter than two characters", () => {
    expect(toPrefixTsQuery("a invoice b")).toBe("invoice:*");
  });

  it("caps at 12 tokens", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const result = toPrefixTsQuery(words.join(" "));
    expect(result.split("|")).toHaveLength(12);
    expect(result.split("|")[0]).toBe("word0:*");
    expect(result.split("|")[11]).toBe("word11:*");
  });

  it("returns an empty string for an empty query", () => {
    expect(toPrefixTsQuery("")).toBe("");
  });

  it("returns an empty string when nothing survives filtering", () => {
    expect(toPrefixTsQuery("a . ! b")).toBe("");
  });

  it("collapses runs of whitespace", () => {
    expect(toPrefixTsQuery("invoice   report")).toBe("invoice:*|report:*");
  });

  it("handles unicode letters", () => {
    expect(toPrefixTsQuery("faktura överföring")).toBe("faktura:*|överföring:*");
  });

  it("drops a single unicode letter as shorter than two characters", () => {
    expect(toPrefixTsQuery("faktura ö")).toBe("faktura:*");
  });
});

describe("queryWords", () => {
  it("extracts words of at least three characters, lowercased", () => {
    expect(queryWords("Invoice Report")).toEqual(["invoice", "report"]);
  });

  it("drops words shorter than three characters", () => {
    expect(queryWords("an invoice ok")).toEqual(["invoice"]);
  });

  it("caps at 8 words", () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`);
    const result = queryWords(words.join(" "));
    expect(result).toHaveLength(8);
    expect(result[0]).toBe("word0");
    expect(result[7]).toBe("word7");
  });

  it("returns an empty array for an empty query", () => {
    expect(queryWords("")).toEqual([]);
  });

  it("returns an empty array when no word survives filtering", () => {
    expect(queryWords("a . ! b")).toEqual([]);
  });

  it("treats underscores as word characters", () => {
    expect(queryWords("my_file")).toEqual(["my_file"]);
  });

  it("handles unicode letters", () => {
    expect(queryWords("Rapport Övning")).toEqual(["rapport", "övning"]);
  });
});
