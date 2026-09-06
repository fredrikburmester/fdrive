import { describe, expect, it } from "vitest";
import { normalizeTagColor, TAG_COLOR_LABELS, TAG_COLORS, tagDotClassName } from "./colors";

describe("normalizeTagColor", () => {
  it("returns a recognized hue unchanged", () => {
    for (const hue of TAG_COLORS) {
      expect(normalizeTagColor(hue)).toBe(hue);
    }
  });

  it("falls back to none for null", () => {
    expect(normalizeTagColor(null)).toBe("none");
  });

  it("falls back to none for undefined", () => {
    expect(normalizeTagColor(undefined)).toBe("none");
  });

  it("falls back to none for an unrecognized value", () => {
    expect(normalizeTagColor("magenta")).toBe("none");
  });
});

describe("tagDotClassName", () => {
  it("returns the bg class for each recognized hue", () => {
    expect(tagDotClassName("red")).toBe("bg-tag-red");
    expect(tagDotClassName("blue")).toBe("bg-tag-blue");
  });

  it("returns the outline class for none/null/unrecognized", () => {
    const noneClass = tagDotClassName(null);
    expect(noneClass).toContain("ring-border");
    expect(tagDotClassName("not-a-color")).toBe(noneClass);
  });
});

describe("TAG_COLOR_LABELS", () => {
  it("has a label for every hue and for none", () => {
    for (const hue of TAG_COLORS) {
      expect(TAG_COLOR_LABELS[hue]).toBeTruthy();
    }
    expect(TAG_COLOR_LABELS.none).toBe("None");
  });
});
