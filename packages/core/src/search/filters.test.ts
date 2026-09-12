import { describe, expect, it } from "vitest";
import { matchesSearchFilters, parseSearchFilters } from "./filters.ts";

describe("parseSearchFilters", () => {
  it("returns every field null for an empty query", () => {
    expect(parseSearchFilters({})).toEqual({
      exts: null,
      folder: null,
      after: null,
      before: null,
    });
  });

  it("normalizes a single extension to lowercase with a leading dot", () => {
    expect(parseSearchFilters({ ext: "PDF" }).exts).toEqual([".pdf"]);
  });

  it("accepts an extension that already has a leading dot", () => {
    expect(parseSearchFilters({ ext: ".pdf" }).exts).toEqual([".pdf"]);
  });

  it("splits a comma-separated extension list", () => {
    expect(parseSearchFilters({ ext: "jpg,png,GIF" }).exts).toEqual([".jpg", ".png", ".gif"]);
  });

  it("ignores blank entries in an extension list", () => {
    expect(parseSearchFilters({ ext: "jpg,,png" }).exts).toEqual([".jpg", ".png"]);
  });

  it("treats a blank ext as unset", () => {
    expect(parseSearchFilters({ ext: "   " }).exts).toBeNull();
  });

  it("treats an ext of only commas as unset", () => {
    expect(parseSearchFilters({ ext: ",," }).exts).toBeNull();
  });

  it("normalizes a folder path", () => {
    expect(parseSearchFilters({ folder: "docs/reports/" }).folder).toBe("/docs/reports");
  });

  it("treats a blank folder as unset", () => {
    expect(parseSearchFilters({ folder: "  " }).folder).toBeNull();
  });

  it("parses a valid after date", () => {
    const filters = parseSearchFilters({ after: "2026-01-01T00:00:00.000Z" });
    expect(filters.after).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("parses a valid before date", () => {
    const filters = parseSearchFilters({ before: "2026-01-01T00:00:00.000Z" });
    expect(filters.before).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("treats an invalid after date as unset", () => {
    expect(parseSearchFilters({ after: "not-a-date" }).after).toBeNull();
  });

  it("treats an invalid before date as unset", () => {
    expect(parseSearchFilters({ before: "not-a-date" }).before).toBeNull();
  });

  it("treats a blank date as unset", () => {
    expect(parseSearchFilters({ after: "" }).after).toBeNull();
  });
});

describe("matchesSearchFilters", () => {
  const entry = { path: "/docs/reports/q1.pdf", ext: ".pdf", modifiedAt: new Date("2026-03-01") };

  it("matches when no filter is set", () => {
    expect(
      matchesSearchFilters(entry, { exts: null, folder: null, after: null, before: null }),
    ).toBe(true);
  });

  it("matches an entry with an allowed extension", () => {
    expect(
      matchesSearchFilters(entry, {
        exts: [".pdf", ".docx"],
        folder: null,
        after: null,
        before: null,
      }),
    ).toBe(true);
  });

  it("rejects an entry with a disallowed extension", () => {
    expect(
      matchesSearchFilters(entry, { exts: [".docx"], folder: null, after: null, before: null }),
    ).toBe(false);
  });

  it("matches an entry within the folder filter", () => {
    expect(
      matchesSearchFilters(entry, { exts: null, folder: "/docs", after: null, before: null }),
    ).toBe(true);
  });

  it("rejects an entry outside the folder filter", () => {
    expect(
      matchesSearchFilters(entry, { exts: null, folder: "/photos", after: null, before: null }),
    ).toBe(false);
  });

  it("matches an entry modified at or after the after filter", () => {
    expect(
      matchesSearchFilters(entry, {
        exts: null,
        folder: null,
        after: new Date("2026-01-01"),
        before: null,
      }),
    ).toBe(true);
  });

  it("rejects an entry modified before the after filter", () => {
    expect(
      matchesSearchFilters(entry, {
        exts: null,
        folder: null,
        after: new Date("2026-06-01"),
        before: null,
      }),
    ).toBe(false);
  });

  it("matches an entry modified at or before the before filter", () => {
    expect(
      matchesSearchFilters(entry, {
        exts: null,
        folder: null,
        after: null,
        before: new Date("2026-06-01"),
      }),
    ).toBe(true);
  });

  it("rejects an entry modified after the before filter", () => {
    expect(
      matchesSearchFilters(entry, {
        exts: null,
        folder: null,
        after: null,
        before: new Date("2026-01-01"),
      }),
    ).toBe(false);
  });
});

it("ignores invalid path filters like invalid dates", () => {
  expect(parseSearchFilters({ folder: "/bad\0path" }).folder).toBeNull();
  expect(parseSearchFilters({ folder: `/${"é".repeat(128)}` }).folder).toBeNull();
});
