/**
 * Minimal stand-in for the upload chunk's `src/lib/dnd.ts`. `deps.ts`
 * re-exports this until the integration chunk repoints it at the real
 * module. The parameter type is a narrow structural subset of the DOM's
 * `DataTransfer` so this stays testable without a real browser drag event.
 */
export interface DraggedPathsCarrier {
  setData(format: string, data: string): void;
  getData(format: string): string;
}

export const INTERNAL_DND_TYPE = "application/x-fdrive-paths";

/** Writes `paths` onto a drag event's data transfer for an internal drag. */
export function writeDraggedPaths(dt: DraggedPathsCarrier, paths: readonly string[]): void {
  dt.setData(INTERNAL_DND_TYPE, JSON.stringify(paths));
}

/**
 * Reads paths previously written by `writeDraggedPaths`, or `null` when the
 * drag did not originate from an internal drag (no data, or malformed data).
 */
export function readDraggedPaths(dt: DraggedPathsCarrier): string[] | null {
  const raw = dt.getData(INTERNAL_DND_TYPE);
  if (raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
