import { describe, expect, it } from "vitest";
import { resolveFolderView } from "./folder-view";

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
});
