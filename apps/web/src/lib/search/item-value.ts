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
export function makeItemValue(kind: SearchItemKind, path: string, identityId?: string): string {
  return identityId === undefined
    ? `${kind}:${path}`
    : `account:${JSON.stringify([kind, path, identityId])}`;
}

/** The `{ kind, path }` a `cmdk` item value encodes, `null` if it is not one `makeItemValue` built. */
export function parseItemValue(
  value: string,
): { kind: SearchItemKind; path: string; identityId?: string } | null {
  if (value.startsWith("account:")) {
    try {
      const parts: unknown = JSON.parse(value.slice(8));
      if (
        Array.isArray(parts) &&
        parts.length === 3 &&
        typeof parts[0] === "string" &&
        isSearchItemKind(parts[0]) &&
        typeof parts[1] === "string" &&
        parts[1].length > 0 &&
        typeof parts[2] === "string" &&
        parts[2].length > 0
      ) {
        return { kind: parts[0], path: parts[1], identityId: parts[2] };
      }
    } catch {
      return null;
    }
    return null;
  }
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
