import { describe, expect, it } from "vitest";
import {
  chipsToQueryParams,
  DEFAULT_SEARCH_CHIPS,
  SEARCH_TYPE_EXTENSIONS,
  SEARCH_TYPE_FILTERS,
  SEARCH_TYPE_LABELS,
} from "./filters";

describe("DEFAULT_SEARCH_CHIPS", () => {
  it("defaults to any type and not folder-only", () => {
    expect(DEFAULT_SEARCH_CHIPS).toEqual({ type: "any", folderOnly: false });
  });
});

describe("SEARCH_TYPE_FILTERS and SEARCH_TYPE_LABELS", () => {
  it("has a label for every filter", () => {
    for (const type of SEARCH_TYPE_FILTERS) {
      expect(typeof SEARCH_TYPE_LABELS[type]).toBe("string");
      expect(SEARCH_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it("has extensions for every filter except any", () => {
    for (const type of SEARCH_TYPE_FILTERS) {
      if (type === "any") {
        continue;
      }
      expect(SEARCH_TYPE_EXTENSIONS[type].length).toBeGreaterThan(0);
    }
  });
});

describe("chipsToQueryParams", () => {
  it("sends no ext or folder for the default chips", () => {
    expect(chipsToQueryParams(DEFAULT_SEARCH_CHIPS, "/docs")).toEqual({
      ext: undefined,
      folder: undefined,
    });
  });

  it("sends the images extension list for the images chip", () => {
    const result = chipsToQueryParams({ type: "images", folderOnly: false }, "/docs");
    expect(result.ext).toBe(SEARCH_TYPE_EXTENSIONS.images.join(","));
    expect(result.folder).toBeUndefined();
  });

  it("sends the current folder when folderOnly is set", () => {
    const result = chipsToQueryParams({ type: "any", folderOnly: true }, "/docs/reports");
    expect(result.folder).toBe("/docs/reports");
    expect(result.ext).toBeUndefined();
  });

  it("sends both ext and folder when both are set", () => {
    const result = chipsToQueryParams({ type: "documents", folderOnly: true }, "/docs");
    expect(result.ext).toBe(SEARCH_TYPE_EXTENSIONS.documents.join(","));
    expect(result.folder).toBe("/docs");
  });
});
