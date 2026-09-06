import { isWithin, parentPath } from "@fdrive/core";

/**
 * True when dropping `source` into `targetFolderPath` is a real, valid
 * move: not a no-op (it is already directly inside that folder), and not a
 * cycle (moving a folder into itself or one of its own descendants).
 */
export function canMoveInto(source: string, targetFolderPath: string): boolean {
  if (parentPath(source) === targetFolderPath) {
    return false;
  }
  return !isWithin(source, targetFolderPath);
}

/** `sources` filtered down to the ones `canMoveInto` `targetFolderPath`. */
export function movablePaths(sources: readonly string[], targetFolderPath: string): string[] {
  return sources.filter((source) => canMoveInto(source, targetFolderPath));
}
