import { FEATURE_IDS } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  WALKTHROUGH_OFFSET,
  WALKTHROUGH_STEPS,
  WALKTHROUGH_TOTAL,
  walkthroughLabel,
} from "./walkthrough";

describe("walkthrough steps", () => {
  it("stays within the contract's walkthroughStep bound", () => {
    expect(WALKTHROUGH_STEPS.length - 1).toBe(9);
  });

  it("walks the six features before Trash, the address, Office, and review", () => {
    expect(WALKTHROUGH_STEPS.map((step) => step.kind)).toEqual([
      ...FEATURE_IDS.map(() => "feature"),
      "trash",
      "publicUrl",
      "office",
      "review",
    ]);
    expect(WALKTHROUGH_STEPS.flatMap((step) => (step.kind === "feature" ? [step.id] : []))).toEqual(
      [...FEATURE_IDS],
    );
  });

  it("counts the wizard's own two steps in the total", () => {
    expect(WALKTHROUGH_OFFSET).toBe(2);
    expect(WALKTHROUGH_TOTAL).toBe(12);
  });

  it("captions a step with its one-based position and label after the wizard", () => {
    expect(walkthroughLabel(0)).toBe("Step 3 of 12 · Thumbnails");
    expect(walkthroughLabel(2)).toBe("Step 5 of 12 · Search OCR");
    expect(walkthroughLabel(6)).toBe("Step 9 of 12 · Trash");
    expect(walkthroughLabel(7)).toBe("Step 10 of 12 · Server address");
    expect(walkthroughLabel(9)).toBe("Step 12 of 12 · Review");
  });

  it("falls back to the section name for a step outside the table", () => {
    expect(walkthroughLabel(10)).toBe("Step 13 of 12 · Features");
  });
});
