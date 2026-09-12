import { isRoot, parentPath } from "@fdrive/core";

/**
 * The "Original folder" column's label for a trashed entry: the parent of
 * its `originalPath`, or "Home" for a top-level entry (whose parent
 * normalizes to the root).
 */
export function originalFolderLabel(originalPath: string): string {
  const parent = parentPath(originalPath);
  return isRoot(parent) ? "Home" : parent;
}

/**
 * Formats a positive hour count as a day count: whole days print without a
 * decimal ("2 days"), everything else rounds to at most one decimal place
 * ("1.5 days"), and exactly one day is singular ("1 day").
 */
export function retentionDaysLabel(retentionHours: number): string {
  const days = Math.round((retentionHours / 24) * 10) / 10;
  const formatted = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${formatted} ${days === 1 ? "day" : "days"}`;
}

/**
 * The Trash page and delete dialog's retention sentence, or `null` when
 * retention is not configured (fdrive never enforces it itself either way,
 * this is purely informational).
 */
export function retentionNote(retentionHours: number | null): string | null {
  if (retentionHours === null) {
    return null;
  }
  return `Items in Trash are removed automatically after ${retentionDaysLabel(retentionHours)}.`;
}

export interface TrashAvailability {
  readonly available: boolean;
  readonly retentionHours: number | null;
}

/**
 * What the delete confirmation should promise. The login's `trash`
 * capability decides between "Move to Trash" and a permanent delete, the
 * same source the row menu labels read, so the two never disagree; the
 * separately cached trash status only contributes its retention note.
 */
export function trashAvailabilityFor(
  capabilities: { readonly trash: boolean },
  status: { readonly retentionHours: number | null } | null | undefined,
): TrashAvailability | null {
  return capabilities.trash
    ? { available: true, retentionHours: status?.retentionHours ?? null }
    : null;
}

export interface DeleteDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  /** The confirm button's label while the request is in flight. */
  readonly pendingLabel: string;
}

/**
 * The delete confirmation dialog's title, body, and confirm button labels:
 * "Move to Trash" copy when the active identity's storage exposes a trash,
 * otherwise the permanent-delete copy. `names` is the list of entries being
 * acted on, in display order; a single entry is quoted by name, more than
 * one is summarized by count. `pendingLabel` replaces `confirmLabel` while
 * the request runs, which can be a while for a large folder or selection.
 */
export function deleteDialogCopy(
  names: readonly string[],
  trash: TrashAvailability | null | undefined,
): DeleteDialogCopy {
  const count = names.length;
  const first = names[0];
  const subject = count === 1 && first !== undefined ? `"${first}"` : `${count} items`;

  if (trash?.available === true) {
    const note = retentionNote(trash.retentionHours);
    const description =
      note === null
        ? `${subject} will be moved to Trash.`
        : `${subject} will be moved to Trash. ${note}`;
    return {
      title: "Move to Trash?",
      description,
      confirmLabel: "Move to Trash",
      pendingLabel: "Moving to Trash…",
    };
  }

  return {
    title: `Delete ${count === 1 ? "item" : "items"}?`,
    description: `${subject} will be permanently deleted. This cannot be undone.`,
    confirmLabel: "Delete",
    pendingLabel: "Deleting…",
  };
}

/** "1 item" or "N items". */
export function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** The success toast after restoring `count` trash entries. */
export function restoredToastMessage(count: number): string {
  return `Restored ${itemCountLabel(count)}.`;
}

/** The success toast after permanently deleting `count` trash entries. */
export function purgedToastMessage(count: number): string {
  return `Deleted ${itemCountLabel(count)} permanently.`;
}

/** The success toast after emptying the whole trash of `count` entries. */
export function emptiedToastMessage(count: number): string {
  return `Trash emptied. ${itemCountLabel(count)} removed permanently.`;
}

/** The "Empty Trash" confirmation dialog's body, naming how many entries it will remove. */
export function emptyTrashConfirmDescription(count: number): string {
  return `This will permanently delete ${itemCountLabel(count)} in Trash. This cannot be undone.`;
}

/** The "Delete permanently" confirmation dialog's body, naming the selection. */
export function purgeConfirmDescription(count: number): string {
  return `${itemCountLabel(count)} will be permanently deleted. This cannot be undone.`;
}

/** The actionable toast shown when restoring `name` conflicts with an existing file at its original path. */
export function restoreConflictMessage(name: string): string {
  return `Could not restore "${name}": a file already exists at that location.`;
}
