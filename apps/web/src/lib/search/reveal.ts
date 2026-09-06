import { baseName, parentPath } from "@fdrive/core";
import { pathToHref } from "./deps";

/**
 * The URL for "reveal in folder": the parent folder's browse route with a
 * `select` query parameter naming the item, so a future browse-page
 * enhancement can scroll to and select it. Today's browse page does not
 * read `select` yet, so this only navigates to the parent folder; that is
 * documented, not a bug, per PLAN.md's Cmd/Ctrl+Enter behaviour.
 * `pathToHref` never produces a URL with its own query string, so this
 * always appends with a plain "?".
 */
export function revealHref(path: string): string {
  const parent = parentPath(path);
  const name = baseName(path);
  const base = pathToHref(parent);
  return `${base}?select=${encodeURIComponent(name)}`;
}
