import { baseName, parentPath } from "@fdrive/core";
import { pathToHref, revealTarget } from "./deps";

/**
 * The URL for "reveal in folder": the parent folder's browse route with a
 * `select` query parameter naming the item, so the file browser scrolls to
 * and selects it once its listing loads. `pathToHref` never produces a URL
 * with its own query string, so `revealTarget` always appends with a plain
 * "?".
 */
export function revealHref(path: string): string {
  const parent = parentPath(path);
  const name = baseName(path);
  return revealTarget(pathToHref(parent), name);
}
