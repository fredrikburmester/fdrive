import { FEATURE_IDS, type FeatureId } from "@fdrive/contracts";
import { FEATURE_DESCRIPTIONS } from "./features";

export type WalkthroughStep =
  | { readonly kind: "feature"; readonly id: FeatureId; readonly label: string }
  | { readonly kind: "trash" | "publicUrl" | "office" | "review"; readonly label: string };

/**
 * The walkthrough's steps, in order: one per optional feature, then Trash,
 * the server address, Office, and the review screen. The index into this
 * table is the `walkthroughStep` persisted in the feature configuration,
 * whose contract bound is `0..9`.
 */
export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
  ...FEATURE_IDS.map(
    (id): WalkthroughStep => ({
      kind: "feature",
      id,
      label: FEATURE_DESCRIPTIONS[id].title,
    }),
  ),
  { kind: "trash", label: "Trash" },
  { kind: "publicUrl", label: "Server address" },
  // The e2e suite drives this step by name; the label is the product's own.
  { kind: "office", label: "ONLYOFFICE" },
  { kind: "review", label: "Review" },
];

/**
 * How many wizard steps come before the walkthrough (claim, SFTPGo,
 * administrator), so walkthrough step 0 is presented as "Step 4".
 */
export const WALKTHROUGH_STEP_OFFSET = 3;

/** Total number of steps a fresh install walks through, wizard included. */
export const WALKTHROUGH_TOTAL = WALKTHROUGH_STEP_OFFSET + WALKTHROUGH_STEPS.length;

/** The "Step 6 of 13 · Search OCR" caption for a walkthrough step index. */
export function walkthroughLabel(step: number): string {
  const label = WALKTHROUGH_STEPS[step]?.label ?? "Features";
  return `Step ${step + WALKTHROUGH_STEP_OFFSET + 1} of ${WALKTHROUGH_TOTAL} · ${label}`;
}
