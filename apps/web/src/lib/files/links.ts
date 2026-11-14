/**
 * A symbolic link a writer outside fdrive (SMB, rsync) left in the files.
 * fdrive never follows one, so a listing shows it only so its name stays
 * visible: it cannot be opened, selected, moved or deleted here.
 */
export function isLink(entry: { readonly kind: string }): boolean {
  return entry.kind === "symlink";
}

/** What a link's row says on hover. */
export const LINK_TITLE = "Symbolic link. fdrive doesn't open links.";
