import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import { requireOfficeEdit } from "./auth.ts";
import { WopiError } from "./errors.ts";
import type { OfficeDeps, OfficeFileRepo, OpenedFile } from "./types.ts";

/**
 * The document's current registry row and path, with edit admission proven
 * there again. Read on the write scope's own connection; called under the
 * document's lock, a write follows a rename and never recreates a deleted path.
 */
export async function currentWriteFile(
  deps: OfficeDeps,
  files: OfficeFileRepo,
  opened: OpenedFile,
): Promise<OpenedFile> {
  const file = await files.get(opened.file.id);
  if (
    file === null ||
    file.id !== opened.file.id ||
    file.providerId !== opened.actor.identity.providerId
  )
    throw new WopiError(404);
  // Round trip under the actor's current configured mappings: the registry
  // row's (rootName, path) must still resolve to the same physical location
  // once mapped back from the virtual path, so a scope that now shadows
  // this file (or a file now out of scope) is never silently reused.
  const path = roundTripVirtualPath(opened.actor.scopes, file.rootName, `/${file.path}`);
  if (path === null) throw new WopiError(404);
  await requireOfficeEdit(deps, opened.actor, path);
  return { ...opened, file, path };
}
