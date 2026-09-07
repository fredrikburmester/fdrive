import {
  baseName,
  extensionOf,
  isRoot,
  joinPath,
  parentPath,
  stripArchiveExtension,
} from "@fdrive/core";

/**
 * The compress dialog's default archive name (no extension), mirroring the
 * API's own default naming rule: a single entry uses its own base name
 * (its file extension, if any, stripped, since that would otherwise end up
 * inside the archive's name); several entries use their common parent
 * folder's name; at the root (no named parent), "archive".
 */
export function defaultArchiveName(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) {
    return "archive";
  }

  if (paths.length === 1) {
    const name = baseName(first);
    const ext = extensionOf(name);
    return ext.length > 0 ? name.slice(0, name.length - ext.length) : name;
  }

  const parent = parentPath(first);
  return isRoot(parent) ? "archive" : baseName(parent);
}

/**
 * The "Extract to" destination when the user picks `parentFolder` to
 * extract `archivePath` under: a new folder inside it, named after the
 * archive with its archive extension stripped, mirroring the API's own
 * default for "Extract here" (a folder beside the archive, same naming)
 * but rooted at the chosen folder instead.
 */
export function extractDestinationUnder(archivePath: string, parentFolder: string): string {
  return joinPath(parentFolder, stripArchiveExtension(baseName(archivePath)));
}
