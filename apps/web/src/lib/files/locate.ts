import { type ApiClient, ApiClientError, type EntryKind } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";

export interface LocatedEntry {
  /** The path as storage spells it. */
  readonly path: string;
  readonly kind: EntryKind;
}

/** The same text for names that read the same: macOS stores "ö" as "o" plus a combining mark, models and typing write one character. */
function nameKey(name: string): string {
  return name.normalize("NFC");
}

/**
 * Finds the stored spelling of a path someone wrote, such as a path in an
 * assistant's reply. Tries the exact path first and lists the parent folder
 * only when that misses, so accents encoded differently still find the item.
 * Returns `null` when nothing is there.
 */
export async function locatePath(
  client: Pick<ApiClient, "stat" | "list">,
  path: string,
): Promise<LocatedEntry | null> {
  if (path === "/") return { path, kind: "dir" };
  try {
    const entry = await client.stat(path);
    return { path: entry.path, kind: entry.kind };
  } catch (error) {
    if (!(error instanceof ApiClientError && error.kind === "not_found")) throw error;
  }
  const parent = await locatePath(client, parentPath(path));
  if (parent?.kind !== "dir") return null;
  const { entries } = await client.list(parent.path);
  const name = baseName(path);
  const match =
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => nameKey(entry.name) === nameKey(name));
  return match === undefined ? null : { path: match.path, kind: match.kind };
}
