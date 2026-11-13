import { FEATURE_IDS, type FeatureId } from "@fdrive/contracts";
import { FEATURE_DESCRIPTIONS } from "./features";
import { SETUP_STEPS } from "./setup-flow";

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
  { kind: "office", label: "Office" },
  { kind: "review", label: "Review" },
];

/** How many wizard steps come before the walkthrough: claiming the installation and the account. */
export const WALKTHROUGH_OFFSET = SETUP_STEPS.length;

/** Total number of steps a fresh install walks through, wizard included. */
export const WALKTHROUGH_TOTAL = WALKTHROUGH_OFFSET + WALKTHROUGH_STEPS.length;

/** The "Step 5 of 12 · Search OCR" caption for a walkthrough step index. */
export function walkthroughLabel(step: number): string {
  const label = WALKTHROUGH_STEPS[step]?.label ?? "Features";
  return `Step ${step + WALKTHROUGH_OFFSET + 1} of ${WALKTHROUGH_TOTAL} · ${label}`;
}
