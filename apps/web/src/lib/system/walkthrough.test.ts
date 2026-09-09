import { FEATURE_IDS } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  WALKTHROUGH_STEP_OFFSET,
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

  it("counts the wizard's own steps in the total", () => {
    expect(WALKTHROUGH_STEP_OFFSET).toBe(3);
    expect(WALKTHROUGH_TOTAL).toBe(13);
  });

  it("captions a step with its one-based position and label", () => {
    expect(walkthroughLabel(0)).toBe("Step 4 of 13 · Thumbnails");
    expect(walkthroughLabel(2)).toBe("Step 6 of 13 · Search OCR");
    expect(walkthroughLabel(6)).toBe("Step 10 of 13 · Trash");
    expect(walkthroughLabel(7)).toBe("Step 11 of 13 · Server address");
    expect(walkthroughLabel(8)).toBe("Step 12 of 13 · ONLYOFFICE");
    expect(walkthroughLabel(9)).toBe("Step 13 of 13 · Review");
  });

  it("falls back to the section name for a step outside the table", () => {
    expect(walkthroughLabel(10)).toBe("Step 14 of 13 · Features");
  });
});
