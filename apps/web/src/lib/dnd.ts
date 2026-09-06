/**
 * Narrow shape of `DataTransfer` this module needs, so tests can use a
 * plain object fake. A real `DataTransfer` satisfies this structurally.
 */
export interface DndDataTransferLike {
  readonly types: readonly string[];
  getData(format: string): string;
  setData(format: string, data: string): void;
}

/**
 * The custom MIME type used to mark a drag as fdrive's own internal
 * drag-and-drop (moving entries within the browser), as opposed to an
 * external drag of files from the OS.
 */
export const INTERNAL_DND_TYPE = "application/x-fdrive-paths";

/** Writes the set of absolute paths being dragged onto `dt` as JSON. */
export function writeDraggedPaths(dt: DndDataTransferLike, paths: readonly string[]): void {
  dt.setData(INTERNAL_DND_TYPE, JSON.stringify(paths));
}

/**
 * Reads the paths written by `writeDraggedPaths`, or `null` when `dt` does
 * not carry the internal type, its payload is missing, or it fails to parse
 * as an array of strings.
 */
export function readDraggedPaths(dt: DndDataTransferLike): string[] | null {
  if (!dt.types.includes(INTERNAL_DND_TYPE)) {
    return null;
  }

  const raw = dt.getData(INTERNAL_DND_TYPE);
  if (raw.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True when `dt` represents a drag of files from outside the browser (its
 * `types` include the standard "Files" marker) rather than fdrive's own
 * internal drag-and-drop.
 */
export function isExternalFileDrag(dt: DndDataTransferLike): boolean {
  return dt.types.includes("Files") && !dt.types.includes(INTERNAL_DND_TYPE);
}

/**
 * Tracks the paths currently being dragged during an internal (fdrive)
 * drag-and-drop gesture, outside of `DataTransfer` itself: browsers only
 * expose a drag's actual payload (via `getData`) on `dragstart` and `drop`,
 * never on `dragover`, but highlighting a hovered drop target as valid or
 * invalid needs to know the dragged paths continuously while the pointer
 * moves. A single page-wide value, rather than React context, because the
 * drag source (a row or tile in the file browser) and every drop target
 * (folder rows, breadcrumb segments, the sidebar tree) are not necessarily
 * nested under one shared component below the app shell.
 */
let activeDragPaths: readonly string[] | null = null;
const dragSessionListeners = new Set<() => void>();

/** Starts an internal drag session, recording the paths being dragged. */
export function startDragSession(paths: readonly string[]): void {
  activeDragPaths = paths;
  for (const listener of dragSessionListeners) {
    listener();
  }
}

/** Ends the current internal drag session, whether it dropped or was cancelled. */
export function endDragSession(): void {
  activeDragPaths = null;
  for (const listener of dragSessionListeners) {
    listener();
  }
}

/** The paths being dragged in the current internal drag session, or `null`
 * when no internal drag is in progress. */
export function getActiveDragPaths(): readonly string[] | null {
  return activeDragPaths;
}

/** Subscribes to drag session start/end, for `useSyncExternalStore`. Returns
 * an unsubscribe function. */
export function subscribeDragSession(listener: () => void): () => void {
  dragSessionListeners.add(listener);
  return () => {
    dragSessionListeners.delete(listener);
  };
}
