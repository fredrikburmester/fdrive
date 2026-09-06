/** The subset of a `KeyboardEvent` this module reasons about. */
export interface EditorKeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

export type Platform = "mac" | "other";

export type EditorAction = "save" | "togglePreview";

/**
 * Maps a key event to an `EditorAction`, or `null` when it is not one of
 * the editor's shortcuts. `primary` is Cmd on mac, Ctrl elsewhere:
 * Cmd/Ctrl+S saves, Cmd/Ctrl+Shift+P toggles the markdown preview pane.
 */
export function keyToEditorAction(event: EditorKeyLike, platform: Platform): EditorAction | null {
  const primary = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (!primary) {
    return null;
  }
  const letter = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (letter === "s" && !event.shiftKey) {
    return "save";
  }
  if (letter === "p" && event.shiftKey) {
    return "togglePreview";
  }
  return null;
}
