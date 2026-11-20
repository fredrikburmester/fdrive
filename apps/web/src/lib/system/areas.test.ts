import { FEATURE_IDS } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  FIRST_SYSTEM_AREA,
  isSystemIndex,
  SYSTEM_AREAS,
  SYSTEM_ROUTE,
  systemAreaFor,
} from "./areas";
import { AI_PAGE, FEATURE_PAGES, OFFICE_PAGE, USERS_PAGE } from "./pages";

describe("the System areas", () => {
  it("lists every area in the order the list shows them", () => {
    expect(SYSTEM_AREAS.map((area) => [area.id, area.label, area.href])).toEqual([
      ["general", "General", "/system/general"],
      ["users", "Users", "/system/users"],
      ["backups", "Backups", "/system/backups"],
      ["thumbnails", "Thumbnails", "/system/thumbnails"],
      ["textSearch", "Full-text search", "/system/indexer"],
      ["semanticSearch", "Semantic search", "/system/search"],
      ["pdfOcr", "Searchable PDFs", "/system/ocr"],
      ["imageSearch", "Image search", "/system/image-search"],
      ["office", "Office", "/system/office"],
      ["ai", "AI", "/system/ai"],
      ["about", "About", "/system/about"],
    ]);
  });

  it("gives every area its own page under System, and one line saying what is inside", () => {
    expect(SYSTEM_ROUTE).toBe("/system");
    expect(new Set(SYSTEM_AREAS.map((area) => area.id)).size).toBe(SYSTEM_AREAS.length);
    expect(new Set(SYSTEM_AREAS.map((area) => area.href)).size).toBe(SYSTEM_AREAS.length);
    for (const area of SYSTEM_AREAS) {
      expect(area.href.startsWith(`${SYSTEM_ROUTE}/`)).toBe(true);
      expect(area.description.length).toBeGreaterThan(0);
      // One line: it sits under the label where the list is a screen of its own.
      expect(area.description).not.toContain("\n");
    }
  });

  it("takes the pages that have links elsewhere from the same table as those links", () => {
    const byId = Object.fromEntries(SYSTEM_AREAS.map((area) => [area.id, area]));
    expect(byId.users).toMatchObject(USERS_PAGE);
    expect(byId.office).toMatchObject(OFFICE_PAGE);
    expect(byId.ai).toMatchObject(AI_PAGE);
    for (const area of SYSTEM_AREAS) {
      if (area.feature !== undefined) expect(area).toMatchObject(FEATURE_PAGES[area.feature]);
    }
  });

  it("marks the areas a feature switch turns on or off, each under its own feature", () => {
    const features = SYSTEM_AREAS.filter((area) => area.feature !== undefined);
    expect(features.map((area) => area.feature)).toEqual([
      "thumbnails",
      "textSearch",
      "semanticSearch",
      "pdfOcr",
      "imageSearch",
    ]);
    for (const area of features) {
      expect(area.id).toBe(area.feature);
      expect(FEATURE_IDS).toContain(area.feature);
    }
    // Search OCR is part of full-text search, so it has no area of its own.
    expect(features.map((area) => area.feature)).not.toContain("searchOcr");
    // Office and AI are turned on from their own settings, not from a feature switch.
    for (const id of ["general", "users", "backups", "office", "ai", "about"]) {
      expect(SYSTEM_AREAS.find((area) => area.id === id)?.feature).toBeUndefined();
    }
  });

  it("says whose live activity each area's row reports", () => {
    expect(
      Object.fromEntries(SYSTEM_AREAS.map((area) => [area.id, area.activity ?? null])),
    ).toEqual({
      general: "general",
      users: "users",
      backups: null,
      thumbnails: "thumbnails",
      textSearch: "textSearch",
      semanticSearch: "semanticSearch",
      pdfOcr: "pdfOcr",
      imageSearch: "imageSearch",
      office: "office",
      ai: null,
      about: null,
    });
  });

  it("opens with General", () => {
    expect(FIRST_SYSTEM_AREA).toBe(SYSTEM_AREAS[0]);
    expect(FIRST_SYSTEM_AREA.id).toBe("general");
  });
});

describe("isSystemIndex", () => {
  it("is true on System itself, with or without a trailing slash", () => {
    expect(isSystemIndex("/system")).toBe(true);
    expect(isSystemIndex("/system/")).toBe(true);
  });

  it("is false inside an area and anywhere else", () => {
    expect(isSystemIndex("/system/general")).toBe(false);
    expect(isSystemIndex("/systems")).toBe(false);
    expect(isSystemIndex("/files")).toBe(false);
    expect(isSystemIndex("")).toBe(false);
    expect(isSystemIndex(null)).toBe(false);
  });
});

describe("systemAreaFor", () => {
  it("finds every area by its own URL", () => {
    for (const area of SYSTEM_AREAS) {
      expect(systemAreaFor(area.href)).toBe(area);
    }
  });

  it("finds an area from a page under it", () => {
    expect(systemAreaFor("/system/backups/restore").id).toBe("backups");
    expect(systemAreaFor("/system/users/").id).toBe("users");
  });

  it("does not take a longer name for the area it starts with", () => {
    // `/system/search` is Semantic search; a path that merely begins the same is no area.
    expect(systemAreaFor("/system/search").id).toBe("semanticSearch");
    expect(systemAreaFor("/system/searching")).toBe(FIRST_SYSTEM_AREA);
  });

  it("falls back to the first area on System itself, an unknown path, or none", () => {
    expect(systemAreaFor("/system")).toBe(FIRST_SYSTEM_AREA);
    expect(systemAreaFor("/system/")).toBe(FIRST_SYSTEM_AREA);
    expect(systemAreaFor("/system/nope")).toBe(FIRST_SYSTEM_AREA);
    expect(systemAreaFor("/files")).toBe(FIRST_SYSTEM_AREA);
    expect(systemAreaFor(null)).toBe(FIRST_SYSTEM_AREA);
  });
});
