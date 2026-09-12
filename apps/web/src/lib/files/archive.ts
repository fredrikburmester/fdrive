import { baseName, joinPath, stripArchiveExtension } from "@fdrive/core";

export { defaultArchiveName } from "@fdrive/core";

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
