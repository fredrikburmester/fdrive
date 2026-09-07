import { describe, expect, it } from "vitest";
import { type ToolbarActionId, toolbarVisibility } from "./toolbar-visibility";

const ALL_ACTIONS: ToolbarActionId[] = [
  "view",
  "upload",
  "duplicate",
  "compress",
  "details",
  "clearSelection",
];

describe("toolbarVisibility", () => {
  it("moves every action into the overflow menu on mobile", () => {
    const layout = toolbarVisibility(true);
    expect(layout.inline).toEqual([]);
    expect(layout.overflow).toEqual(ALL_ACTIONS);
  });

  it("keeps every action inline on desktop, unchanged from before the mobile layout", () => {
    const layout = toolbarVisibility(false);
    expect(layout.inline).toEqual(ALL_ACTIONS);
    expect(layout.overflow).toEqual([]);
  });
});
