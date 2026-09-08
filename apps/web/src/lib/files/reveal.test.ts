import { describe, expect, it } from "vitest";
import {
  cleanupSelectParam,
  findRevealIndex,
  gridRowForIndex,
  parseSelectParam,
  revealTarget,
  shouldPerformReveal,
} from "./reveal";

describe("revealTarget", () => {
  it("appends a select query parameter to a bare href", () => {
    expect(revealTarget("/files/docs", "readme.md")).toBe("/files/docs?select=readme.md");
  });

  it("url-encodes a name with special characters", () => {
    expect(revealTarget("/files/docs", "a b & c.txt")).toBe(
      "/files/docs?select=a%20b%20%26%20c.txt",
    );
  });

  it("uses '&' when the href already has a query string", () => {
    expect(revealTarget("/files/docs?sort=name", "readme.md")).toBe(
      "/files/docs?sort=name&select=readme.md",
    );
  });
});

describe("parseSelectParam", () => {
  it("reads a select param from a leading-'?' search string", () => {
    expect(parseSelectParam("?select=readme.md")).toBe("readme.md");
  });

  it("reads a select param from a bare search string", () => {
    expect(parseSelectParam("select=readme.md")).toBe("readme.md");
  });

  it("decodes a url-encoded name", () => {
    expect(parseSelectParam("?select=a%20b%20%26%20c.txt")).toBe("a b & c.txt");
  });

  it("returns null when there is no select param", () => {
    expect(parseSelectParam("?sort=name")).toBeNull();
  });

  it("returns null for an empty search string", () => {
    expect(parseSelectParam("")).toBeNull();
  });

  it("returns null for an empty select value", () => {
    expect(parseSelectParam("?select=")).toBeNull();
  });
});

describe("findRevealIndex", () => {
  const entries = [{ path: "/docs/a.txt" }, { path: "/docs/b.txt" }, { path: "/docs/c.txt" }];

  it("returns -1 for null target", () => {
    expect(findRevealIndex(entries, null)).toBe(-1);
  });

  it("returns matching index", () => {
    expect(findRevealIndex(entries, "/docs/b.txt")).toBe(1);
  });

  it("returns -1 for missing target", () => {
    expect(findRevealIndex(entries, "/docs/missing.txt")).toBe(-1);
  });
});

describe("gridRowForIndex", () => {
  it("returns -1 for negative index", () => {
    expect(gridRowForIndex(-1, 4)).toBe(-1);
  });

  it("calculates row correctly", () => {
    expect(gridRowForIndex(0, 4)).toBe(0);
    expect(gridRowForIndex(3, 4)).toBe(0);
    expect(gridRowForIndex(4, 4)).toBe(1);
    expect(gridRowForIndex(9, 4)).toBe(2);
  });

  it("handles 0 or negative columns gracefully", () => {
    expect(gridRowForIndex(5, 0)).toBe(5);
  });
});

describe("shouldPerformReveal", () => {
  const paths = ["/docs/a.txt", "/docs/b.txt"];

  it("returns true when target is present and not last revealed", () => {
    expect(shouldPerformReveal("/docs/a.txt", paths, null)).toBe(true);
    expect(shouldPerformReveal("/docs/a.txt", paths, "/docs/b.txt")).toBe(true);
  });

  it("returns false when target is null", () => {
    expect(shouldPerformReveal(null, paths, null)).toBe(false);
  });

  it("returns false when target is not in ordered paths", () => {
    expect(shouldPerformReveal("/docs/c.txt", paths, null)).toBe(false);
  });

  it("returns false when target matches last revealed", () => {
    expect(shouldPerformReveal("/docs/a.txt", paths, "/docs/a.txt")).toBe(false);
  });
});

describe("cleanupSelectParam", () => {
  it("returns empty string when select is the only parameter", () => {
    expect(cleanupSelectParam("?select=readme.md")).toBe("");
    expect(cleanupSelectParam("select=readme.md")).toBe("");
  });

  it("preserves other parameters", () => {
    expect(cleanupSelectParam("?select=readme.md&sort=name")).toBe("?sort=name");
    expect(cleanupSelectParam("?view=grid&select=readme.md")).toBe("?view=grid");
  });

  it("returns empty string for empty search", () => {
    expect(cleanupSelectParam("")).toBe("");
  });
});
