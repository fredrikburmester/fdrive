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

export interface DeleteDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  /** The confirm button's label while the request is in flight. */
  readonly pendingLabel: string;
}

/** "1 day" or "N days". */
export function dayCountLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * When Trash deletes what it holds, for the Trash page and the delete
 * dialog, or `null` until the setting has loaded.
 */
export function retentionNote(retentionDays: number | undefined): string | null {
  return retentionDays === undefined
    ? null
    : `Items in Trash are deleted permanently after ${dayCountLabel(retentionDays)}.`;
}

/** One item the delete dialog asks about: its name, and whose Trash it goes to when not the login's. */
export interface DeleteItem {
  readonly name: string;
  /** The owner of the folder shared with the login that holds it; their Trash takes it. */
  readonly owner?: string | undefined;
}

/**
 * The delete confirmation dialog's title, body, and confirm button labels.
 * Every delete moves to Trash: the login's own, or, for an item in a folder
 * shared with it, the owner's, which keeps it `retentionDays` (when known)
 * before deleting it permanently. A single item is quoted by name, more than
 * one is summarized by count. `pendingLabel` replaces `confirmLabel` while
 * the request runs, which can be a while for a large folder or selection.
 */
export function deleteDialogCopy(
  items: readonly DeleteItem[],
  retentionDays: number | undefined,
): DeleteDialogCopy {
  const count = items.length;
  const first = items[0];
  const subject = count === 1 && first !== undefined ? `"${first.name}"` : `${count} items`;
  const owners = new Set(items.map((item) => item.owner));
  const owner = owners.size === 1 ? first?.owner : undefined;
  const sentences = [
    `${subject} will be moved to ${owner === undefined ? "Trash" : `${owner}'s Trash`}.`,
  ];
  if (owners.size > 1)
    sentences.push("Items in folders shared with you go to their owner's Trash.");
  const note = retentionNote(retentionDays);
  if (note !== null) sentences.push(note);
  return {
    title: "Move to Trash?",
    description: sentences.join(" "),
    confirmLabel: "Move to Trash",
    pendingLabel: "Moving to Trash…",
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
