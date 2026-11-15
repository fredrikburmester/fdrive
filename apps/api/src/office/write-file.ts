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
  if (file === null || file.id !== opened.file.id) throw new WopiError(404);
  // Where the row is for this login now: a folder no longer shared with it,
  // or one that now hides the document, is never silently reused.
  const path = await deps.grants.pathFor(opened.actor.identity.id, file);
  if (path === null) throw new WopiError(404);
  await requireOfficeEdit(deps, opened.actor, path);
  return { ...opened, file, path };
}
