import type { OcrOriginal, OcrOriginalState } from "@fdrive/contracts";

/** Badge wording and tone for the state of a kept original's source file. */
export const ORIGINAL_STATE_LABEL: Record<OcrOriginalState, string> = {
  ocred: "OCR'd",
  restored: "Restored",
  changed: "Changed since OCR",
  missing: "File deleted",
};

export const ORIGINAL_STATE_TONE: Record<
  OcrOriginalState,
  "outline" | "secondary" | "destructive"
> = {
  ocred: "outline",
  restored: "secondary",
  changed: "destructive",
  missing: "destructive",
};

/** What the row shows as the source of a kept original. */
export function originalTitle(original: OcrOriginal): string {
  return original.path ?? original.id;
}

/**
 * The confirmation an operator must read before a restore overwrites something.
 * `ocred` and `restored` are the harmless cases; the other two each destroy
 * something the kept original cannot describe, and say so plainly.
 */
export function restoreConfirmation(state: OcrOriginalState | null): {
  title: string;
  description: string;
  destructive: boolean;
} {
  switch (state) {
    case "changed":
      return {
        title: "Overwrite the changed file?",
        description:
          "This file was edited or replaced after OCR ran. Restoring the original discards those changes permanently.",
        destructive: true,
      };
    case "missing":
      return {
        title: "Recreate the deleted file?",
        description:
          "Nothing is at this path any more. Restoring puts the original back, recreating a file that was moved, renamed or deleted.",
        destructive: true,
      };
    case "restored":
      return {
        title: "Restore this original again?",
        description:
          "This file already matches the kept original, so restoring it changes nothing.",
        destructive: false,
      };
    default:
      return {
        title: "Restore the original?",
        description:
          "The searchable text layer is removed and the file goes back to exactly the bytes OCR replaced. The kept copy stays, so this can be undone by running OCR again.",
        destructive: false,
      };
  }
}

/**
 * Whether restoring in this state needs the caller to opt into a destructive
 * case, mirroring the two opt-ins the API requires.
 */
export function restoreOptIns(state: OcrOriginalState | null): {
  allowRecreate: boolean;
  allowOverwriteChanged: boolean;
} {
  return {
    allowRecreate: state === "missing",
    allowOverwriteChanged: state === "changed",
  };
}

/** Whether a kept original can be put back at all, or only downloaded. */
export function isRestorable(original: OcrOriginal): boolean {
  return original.path !== null && original.state !== null;
}

/** "1–25 of 132", or an empty-state line, for the sheet's pager. */
export function pageSummary(total: number, offset: number, count: number): string {
  if (total === 0) {
    return "No kept originals";
  }
  return `${offset + 1}–${offset + count} of ${total}`;
}
