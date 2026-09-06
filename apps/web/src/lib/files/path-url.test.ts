import { describe, expect, it } from "vitest";
import { buildBreadcrumbs, pathToHref, segmentsToPath, viewHref } from "./path-url";

describe("pathToHref", () => {
  it("maps the root to /files", () => {
    expect(pathToHref("/")).toBe("/files");
  });

  it("encodes each segment", () => {
    expect(pathToHref("/a/b c")).toBe("/files/a/b%20c");
  });

  it("encodes unicode segments", () => {
    expect(pathToHref("/résumés/2024")).toBe("/files/r%C3%A9sum%C3%A9s/2024");
  });

  it("encodes # and ? within a segment", () => {
    expect(pathToHref("/a#1?b")).toBe(`/files/${encodeURIComponent("a#1?b")}`);
  });
});

describe("viewHref", () => {
  it("maps the root to /view", () => {
    expect(viewHref("/")).toBe("/view");
  });

  it("encodes segments", () => {
    expect(viewHref("/a/b c.txt")).toBe("/view/a/b%20c.txt");
  });
});

describe("segmentsToPath", () => {
  it("maps undefined to the root", () => {
    expect(segmentsToPath(undefined)).toBe("/");
  });

  it("maps an empty array to the root", () => {
    expect(segmentsToPath([])).toBe("/");
  });

  it("decodes and joins segments", () => {
    expect(segmentsToPath(["a", "b%20c"])).toBe("/a/b c");
  });

  it("decodes unicode segments", () => {
    expect(segmentsToPath(["r%C3%A9sum%C3%A9s", "2024"])).toBe("/résumés/2024");
  });

  it("decodes # and ?", () => {
    expect(segmentsToPath([encodeURIComponent("a#1?b")])).toBe("/a#1?b");
  });

  it("falls back to the raw segment when percent-decoding fails", () => {
    expect(segmentsToPath(["100%"])).toBe("/100%");
  });

  it("round-trips through pathToHref", () => {
    const original = "/résumés/a#1?b/c d";
    const href = pathToHref(original);
    const segments = href.slice("/files/".length).split("/");
    expect(segmentsToPath(segments)).toBe(original);
  });
});

describe("buildBreadcrumbs", () => {
  it("returns just Home for the root", () => {
    expect(buildBreadcrumbs("/")).toEqual([{ name: "Home", path: "/", href: "/files" }]);
  });

  it("builds one crumb per segment", () => {
    expect(buildBreadcrumbs("/a/b")).toEqual([
      { name: "Home", path: "/", href: "/files" },
      { name: "a", path: "/a", href: "/files/a" },
      { name: "b", path: "/a/b", href: "/files/a/b" },
    ]);
  });
});
