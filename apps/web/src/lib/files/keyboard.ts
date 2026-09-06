export type FilesActionType =
  | "move"
  | "open"
  | "quickLook"
  | "delete"
  | "selectAll"
  | "clear"
  | "rename"
  | "download"
  | "newFolder"
  | "goToParent";

export interface MoveAction {
  readonly type: "move";
  readonly direction: "up" | "down";
  readonly extend: boolean;
}

export interface SimpleAction {
  readonly type: Exclude<FilesActionType, "move">;
}

export type FilesAction = MoveAction | SimpleAction;

/** The subset of a `KeyboardEvent` this module reasons about. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export type Platform = "mac" | "other";

/**
 * Maps a key event to a `FilesAction`, or `null` when it is not one of the
 * file browser's shortcuts. `primary` is Cmd on mac, Ctrl elsewhere.
 *
 * On mac, deleting requires the primary modifier (Cmd+Delete/Backspace),
 * matching Finder; elsewhere plain Delete/Backspace deletes, matching
 * Explorer and most file managers (Ctrl+Delete/Backspace also works).
 */
export function keyToAction(event: KeyLike, platform: Platform): FilesAction | null {
  const primary = platform === "mac" ? event.metaKey : event.ctrlKey;
  const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
  const letter = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (event.key === "ArrowUp" && primary) {
    return { type: "goToParent" };
  }
  if (event.key === "ArrowUp") {
    return { type: "move", direction: "up", extend: event.shiftKey };
  }
  if (event.key === "ArrowDown") {
    return { type: "move", direction: "down", extend: event.shiftKey };
  }
  if (event.key === "Enter") {
    return { type: "open" };
  }
  if (event.key === " ") {
    return { type: "quickLook" };
  }
  if (isDeleteKey && (platform === "mac" ? primary : true)) {
    return { type: "delete" };
  }
  if (primary && !event.altKey && letter === "a") {
    return { type: "selectAll" };
  }
  if (event.key === "Escape") {
    return { type: "clear" };
  }
  if (event.key === "F2") {
    return { type: "rename" };
  }
  if (primary && !event.altKey && event.shiftKey && letter === "n") {
    return { type: "newFolder" };
  }
  if (primary && !event.altKey && letter === "d") {
    return { type: "download" };
  }

  return null;
}
