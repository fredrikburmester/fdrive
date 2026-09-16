import { describe, expect, it } from "vitest";
import { resolveFolderSort, resolveFolderView } from "./folder-view";

describe("resolveFolderView", () => {
  it("uses the global default without an exact pin", () => {
    expect(resolveFolderView("/photos", null, "grid")).toBe("grid");
    expect(resolveFolderView("/photos", undefined, "tree")).toBe("tree");
    expect(resolveFolderView("/photos/2024", { path: "/photos", mode: "grid" }, "list")).toBe(
      "list",
    );
    expect(resolveFolderView("/sibling", { path: "/photos", mode: "grid" }, "list")).toBe("list");
  });
  it("pins all supported modes independently, including root", () => {
    for (const mode of ["list", "grid", "tree"] as const) {
      expect(resolveFolderView("/", { path: "/", mode }, "grid")).toBe(mode);
    }
  });
  it("falls back to the default when only the sort is pinned", () => {
    const pin = { path: "/photos", mode: null, sort: { key: "size", direction: "desc" } } as const;
    expect(resolveFolderView("/photos", pin, "grid")).toBe("grid");
  });
});

describe("resolveFolderSort", () => {
  const fallback = { key: "name", direction: "asc" } as const;
  const pinned = { key: "modifiedAt", direction: "desc" } as const;

  it("uses the global default without an exact sort pin", () => {
    expect(resolveFolderSort("/photos", null, fallback)).toBe(fallback);
    expect(resolveFolderSort("/photos", { path: "/photos", mode: "grid" }, fallback)).toBe(
      fallback,
    );
    expect(
      resolveFolderSort("/photos", { path: "/photos", mode: "grid", sort: null }, fallback),
    ).toBe(fallback);
    expect(
      resolveFolderSort("/photos/2024", { path: "/photos", mode: null, sort: pinned }, fallback),
    ).toBe(fallback);
  });
  it("uses an exact sort pin whether or not a mode is pinned", () => {
    expect(
      resolveFolderSort("/photos", { path: "/photos", mode: null, sort: pinned }, fallback),
    ).toBe(pinned);
    expect(resolveFolderSort("/", { path: "/", mode: "tree", sort: pinned }, fallback)).toBe(
      pinned,
    );
  });
});
