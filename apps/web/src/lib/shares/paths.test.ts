import { describe, expect, it } from "vitest";
import { appendShareName, publicShareHref, publicUploadPath, shareBreadcrumbs } from "./paths";

const id = "00000000-0000-4000-8000-000000000001";
describe("public share paths", () => {
  it("preserves Unicode and literal percent through navigation", () => {
    expect(publicShareHref(id)).toBe(`/s/${id}`);
    expect(publicShareHref(id, "/日本/%2f.txt")).toBe(
      `/s/${id}?path=%2F%E6%97%A5%E6%9C%AC%2F%252f.txt`,
    );
    expect(appendShareName("/日本", "%2f.txt")).toBe("/日本/%2f.txt");
    expect(publicUploadPath("100%.txt")).toBe("/100%.txt");
    expect(shareBreadcrumbs("/")).toEqual([{ name: "Shared files", path: "/" }]);
    expect(shareBreadcrumbs("/日本/100%")).toEqual([
      { name: "Shared files", path: "/" },
      { name: "日本", path: "/日本" },
      { name: "100%", path: "/日本/100%" },
    ]);
  });
  it("rejects traversal, invalid identifiers, and directory upload names", () => {
    expect(() => publicShareHref("bad")).toThrow();
    for (const path of ["/../x", "/a//b", "/a\\b"])
      expect(() => publicShareHref(id, path)).toThrow();
    for (const name of ["", ".", "..", "a/b", "a\\b", "\u0000"])
      expect(() => appendShareName("/", name)).toThrow();
    expect(() => publicUploadPath("a/b")).toThrow();
  });
});
