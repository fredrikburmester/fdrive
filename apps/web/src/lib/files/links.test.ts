import { describe, expect, it } from "vitest";
import { isLink } from "./links";

describe("isLink", () => {
  it("tells a symbolic link from everything else", () => {
    expect(isLink({ kind: "symlink" })).toBe(true);
    for (const kind of ["file", "dir", "other"]) expect(isLink({ kind })).toBe(false);
  });
});
