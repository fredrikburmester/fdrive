import { FEATURE_IDS } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  WALKTHROUGH_STEPS,
  walkthroughLabel,
  walkthroughOffset,
  walkthroughTotal,
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

  it("counts the wizard's own steps in the total, per setup mode", () => {
    expect(walkthroughOffset("local")).toBe(2);
    expect(walkthroughTotal("local")).toBe(12);
    expect(walkthroughOffset("provider")).toBe(3);
    expect(walkthroughTotal("provider")).toBe(13);
  });

  it("captions a step with its one-based position and label after a local folder's setup", () => {
    expect(walkthroughLabel(0, "local")).toBe("Step 3 of 12 · Thumbnails");
    expect(walkthroughLabel(2, "local")).toBe("Step 5 of 12 · Search OCR");
    expect(walkthroughLabel(6, "local")).toBe("Step 9 of 12 · Trash");
    expect(walkthroughLabel(9, "local")).toBe("Step 12 of 12 · Review");
  });

  it("counts the storage step when setup connected storage", () => {
    expect(walkthroughLabel(0, "provider")).toBe("Step 4 of 13 · Thumbnails");
    expect(walkthroughLabel(7, "provider")).toBe("Step 11 of 13 · Server address");
    expect(walkthroughLabel(8, "provider")).toBe("Step 12 of 13 · Office");
    expect(walkthroughLabel(9, "provider")).toBe("Step 13 of 13 · Review");
  });

  it("falls back to the section name for a step outside the table", () => {
    expect(walkthroughLabel(10, "local")).toBe("Step 13 of 12 · Features");
  });
});
