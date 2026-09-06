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
