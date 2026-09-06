import type { Tag } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { filterTags, hasNoExactMatch } from "./filter-tags";

const TAGS: Tag[] = [
  { id: "1", name: "Work", color: "blue" },
  { id: "2", name: "Personal", color: "green" },
  { id: "3", name: "worker-notes", color: null },
];

describe("filterTags", () => {
  it("returns every tag for an empty query", () => {
    expect(filterTags(TAGS, "")).toEqual(TAGS);
  });

  it("returns every tag for a whitespace-only query", () => {
    expect(filterTags(TAGS, "   ")).toEqual(TAGS);
  });

  it("matches case-insensitively by substring", () => {
    expect(filterTags(TAGS, "work")).toEqual([TAGS[0], TAGS[2]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterTags(TAGS, "zzz")).toEqual([]);
  });
});

describe("hasNoExactMatch", () => {
  it("is false for an empty query", () => {
    expect(hasNoExactMatch(TAGS, "")).toBe(false);
  });

  it("is false when a tag matches exactly (case-insensitive)", () => {
    expect(hasNoExactMatch(TAGS, "work")).toBe(false);
    expect(hasNoExactMatch(TAGS, "Work")).toBe(false);
  });

  it("is true when only a partial match exists", () => {
    expect(hasNoExactMatch(TAGS, "work-")).toBe(true);
  });

  it("is true when nothing matches at all", () => {
    expect(hasNoExactMatch(TAGS, "zzz")).toBe(true);
  });
});
