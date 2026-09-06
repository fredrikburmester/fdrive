import { pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { formatVectorLiteral, parseVectorLiteral, vector } from "./vector.js";

const testTable = pgTable("vector_test", {
  embedding: vector("embedding", { dimensions: 3 }),
});

describe("formatVectorLiteral", () => {
  it("formats a number array as a bracketed comma-separated literal", () => {
    expect(formatVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("formats an empty array", () => {
    expect(formatVectorLiteral([])).toBe("[]");
  });

  it("formats a single-element array without a trailing comma", () => {
    expect(formatVectorLiteral([1])).toBe("[1]");
  });
});

describe("parseVectorLiteral", () => {
  it("parses a bracketed literal back into numbers", () => {
    expect(parseVectorLiteral("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
  });

  it("parses a literal without brackets", () => {
    expect(parseVectorLiteral("0.1,0.2,0.3")).toEqual([0.1, 0.2, 0.3]);
  });

  it("parses an empty bracketed literal to an empty array", () => {
    expect(parseVectorLiteral("[]")).toEqual([]);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseVectorLiteral("  [1,2]  ")).toEqual([1, 2]);
  });

  it("round-trips through format and parse", () => {
    const original = [0.1, -0.5, 3, 42.42];
    expect(parseVectorLiteral(formatVectorLiteral(original))).toEqual(original);
  });
});

describe("vector custom type", () => {
  it("builds a column with the dimensioned SQL type", () => {
    expect(testTable.embedding.getSQLType()).toBe("vector(3)");
  });

  it("maps a JS array to the driver's text literal", () => {
    expect(testTable.embedding.mapToDriverValue([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("maps the driver's text literal back to a JS array", () => {
    expect(testTable.embedding.mapFromDriverValue("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
  });
});
