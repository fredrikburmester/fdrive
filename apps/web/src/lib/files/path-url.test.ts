import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbs,
  originFolder,
  pathFromFilesPathname,
  pathToHref,
  returnHref,
  segmentsToPath,
  viewHref,
} from "./path-url";

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

  it("remembers a folder above the file's own, the way a tree opens it", () => {
    expect(viewHref("/scores/a b.png", "/")).toBe("/view/scores/a%20b.png?from=%2F");
    expect(viewHref("/a/b/c.png", "/a")).toBe("/view/a/b/c.png?from=%2Fa");
  });

  it("leaves the URL alone when the file was opened from its own folder", () => {
    expect(viewHref("/a/c.png", "/a")).toBe("/view/a/c.png");
    expect(viewHref("/c.png", "/")).toBe("/view/c.png");
  });

  it("ignores a folder that is not above the file", () => {
    expect(viewHref("/a/c.png", "/b")).toBe("/view/a/c.png");
    expect(viewHref("/ab/c.png", "/a")).toBe("/view/ab/c.png");
  });
});

describe("returnHref", () => {
  it("goes back to the folder the file was opened from, with the file selected there", () => {
    expect(returnHref("/scores/a b.png", "/")).toBe("/files?select=scores%2Fa%20b.png");
    expect(returnHref("/a/b/c.png", "/a")).toBe("/files/a?select=b%2Fc.png");
  });

  it("falls back to the file's own folder", () => {
    expect(returnHref("/a/c.png", null)).toBe("/files/a?select=c.png");
    expect(returnHref("/a/c.png", "/elsewhere")).toBe("/files/a?select=c.png");
    expect(returnHref("/c.png", undefined)).toBe("/files?select=c.png");
  });

  it("names the folder it returns to in originFolder", () => {
    expect(originFolder("/a/b/c.png", "/a")).toBe("/a");
    expect(originFolder("/a/b/c.png", "/a/b/c.png")).toBe("/a/b");
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

describe("pathFromFilesPathname", () => {
  it("maps the Files root to /", () => {
    expect(pathFromFilesPathname("/files")).toBe("/");
  });

  it("decodes a nested Files path", () => {
    expect(pathFromFilesPathname("/files/a/b%20c")).toBe("/a/b c");
  });

  it("returns null for null", () => {
    expect(pathFromFilesPathname(null)).toBeNull();
  });

  it("returns null for an unrelated route", () => {
    expect(pathFromFilesPathname("/about")).toBeNull();
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
