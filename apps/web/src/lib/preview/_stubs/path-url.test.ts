import { describe, expect, it } from "vitest";
import { pathToHref, segmentsToPath, viewHref } from "./path-url";

describe("segmentsToPath", () => {
  it("returns the root for an empty segment list", () => {
    expect(segmentsToPath([])).toBe("/");
  });

  it("joins and decodes segments", () => {
    expect(segmentsToPath(["docs", "my%20file.txt"])).toBe("/docs/my file.txt");
  });

  it("keeps a segment unchanged when it is not validly encoded", () => {
    expect(segmentsToPath(["100%"])).toBe("/100%");
  });
});

describe("pathToHref", () => {
  it("returns the browser root for the root path", () => {
    expect(pathToHref("/")).toBe("/browse");
  });

  it("builds an encoded href for a nested path", () => {
    expect(pathToHref("/docs/my file.txt")).toBe("/browse/docs/my%20file.txt");
  });
});

describe("viewHref", () => {
  it("returns the view root for the root path", () => {
    expect(viewHref("/")).toBe("/view");
  });

  it("builds an encoded href for a nested path", () => {
    expect(viewHref("/docs/report.pdf")).toBe("/view/docs/report.pdf");
  });
});
