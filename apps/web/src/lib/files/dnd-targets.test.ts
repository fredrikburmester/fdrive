import { describe, expect, it } from "vitest";
import { dropTargetState, effectFor } from "./dnd-targets";

describe("dropTargetState", () => {
  it("is valid for an unrelated destination folder", () => {
    expect(dropTargetState(["/a/file.txt"], "/b")).toBe("valid");
  });

  it("is invalid when the target is the dragged item's own parent", () => {
    expect(dropTargetState(["/a/file.txt"], "/a")).toBe("invalid");
  });

  it("is invalid when the target is the dragged item itself", () => {
    expect(dropTargetState(["/a/folder"], "/a/folder")).toBe("invalid");
  });

  it("is invalid when the target is a descendant of the dragged folder", () => {
    expect(dropTargetState(["/a/folder"], "/a/folder/child")).toBe("invalid");
  });

  it("is valid when only some of a mixed selection can move there", () => {
    // "/a/file.txt" cannot move into its own parent "/a", but
    // "/elsewhere/file2.txt" can, so the target still highlights.
    expect(dropTargetState(["/a/file.txt", "/elsewhere/file2.txt"], "/a")).toBe("valid");
  });

  it("is invalid for an empty selection", () => {
    expect(dropTargetState([], "/b")).toBe("invalid");
  });
});

describe("effectFor", () => {
  it("is copy when Alt/Option is held", () => {
    expect(effectFor({ altKey: true })).toBe("copy");
  });

  it("is move otherwise", () => {
    expect(effectFor({ altKey: false })).toBe("move");
  });
});
