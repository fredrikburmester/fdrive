/** Which section of the search panel a `cmdk` item value came from. */
export type SearchItemKind = "folder" | "file" | "content" | "recent";

const VALID_KINDS: readonly SearchItemKind[] = ["folder", "file", "content", "recent"];

function isSearchItemKind(value: string): value is SearchItemKind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

/**
 * Builds the unique, stable `value` a `cmdk` `CommandItem` needs: a file's
 * path can appear in more than one section (a filename match and a content
 * match for the same file, say), so the section is folded into the value to
 * keep every item's value unique within the panel.
 */
export function makeItemValue(kind: SearchItemKind, path: string): string {
  return `${kind}:${path}`;
}

/** The `{ kind, path }` a `cmdk` item value encodes, `null` if it is not one `makeItemValue` built. */
export function parseItemValue(value: string): { kind: SearchItemKind; path: string } | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const kind = value.slice(0, separatorIndex);
  const path = value.slice(separatorIndex + 1);
  if (!isSearchItemKind(kind) || path.length === 0) {
    return null;
  }
  return { kind, path };
}
