import type { FsEntry } from "@fdrive/contracts";

/** Summary of a multi-file selection, for the inspector's selection card. */
export interface SelectionSummary {
  readonly count: number;
  readonly totalSize: number;
}

/**
 * Summarizes a selection of entries: how many there are and the sum of
 * their sizes. Directories contribute their own reported size (usually 0);
 * this function does not walk into folders.
 */
export function summarizeSelection(entries: readonly FsEntry[]): SelectionSummary {
  return {
    count: entries.length,
    totalSize: entries.reduce((total, entry) => total + entry.size, 0),
  };
}
