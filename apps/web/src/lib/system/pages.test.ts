import { FEATURE_IDS } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { FEATURE_PAGES, OFFICE_PAGE } from "./pages";

describe("system page links", () => {
  it("gives every feature a System page under /system", () => {
    for (const id of FEATURE_IDS) {
      const page = FEATURE_PAGES[id];
      expect(page.href.startsWith("/system/")).toBe(true);
      expect(page.label.length).toBeGreaterThan(0);
    }
  });

  it("sends both indexer-backed text features to the Indexer page", () => {
    expect(FEATURE_PAGES.textSearch).toEqual(FEATURE_PAGES.searchOcr);
    expect(FEATURE_PAGES.textSearch.href).toBe("/system/indexer");
  });

  it("keeps Office out of the feature table but on its own page", () => {
    expect(OFFICE_PAGE.href).toBe("/system/office");
    expect(Object.values(FEATURE_PAGES).map((page) => page.href)).not.toContain(OFFICE_PAGE.href);
  });
});
