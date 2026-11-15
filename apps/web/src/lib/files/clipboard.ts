/** What ⌘C or ⌘X in the file browser put on fdrive's own clipboard. */
export interface FileClipboard {
  readonly mode: "copy" | "cut";
  readonly paths: readonly string[];
}

/**
 * Kept in memory for the tab, never on the system clipboard: it survives moving between
 * folders, not a reload.
 */
let clipboard: FileClipboard | null = null;

export function writeFileClipboard(next: FileClipboard): void {
  clipboard = next;
}

/** What ⌘V pastes: a cut is pasted once, a copy as often as wanted. */
export function takeFileClipboard(): FileClipboard | null {
  const current = clipboard;
  if (current?.mode === "cut") clipboard = null;
  return current;
}
