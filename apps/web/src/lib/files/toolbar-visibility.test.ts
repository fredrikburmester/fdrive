import { describe, expect, it } from "vitest";
import { type ToolbarActionId, toolbarVisibility } from "./toolbar-visibility";

const ALL_ACTIONS: ToolbarActionId[] = [
  "view",
  "upload",
  "duplicate",
  "compress",
  "download",
  "details",
  "clearSelection",
];

describe("toolbarVisibility", () => {
  it("moves Upload into the New menu and every other action into the overflow menu on mobile", () => {
    const layout = toolbarVisibility(true);
    expect(layout.inline).toEqual([]);
    expect(layout.newMenu).toEqual(["upload"]);
    expect(layout.overflow).toEqual(ALL_ACTIONS.filter((id) => id !== "upload"));
  });

  it("keeps every action inline on desktop, unchanged from before the mobile layout", () => {
    const layout = toolbarVisibility(false);
    expect(layout.inline).toEqual(ALL_ACTIONS);
    expect(layout.overflow).toEqual([]);
    expect(layout.newMenu).toEqual([]);
  });
});
