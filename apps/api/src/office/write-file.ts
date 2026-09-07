import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import { requireOfficeEdit } from "./auth.ts";
import { WopiError } from "./errors.ts";
import type { OfficeDeps, OfficeFileRepo, OpenedFile } from "./types.ts";

/** Resolve under the provider write scope without reacquiring credentials or a pool connection. */
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
  // once mapped back from the virtual path, so a mapping change that now
  // shadows this file (or moves it out of scope) is never silently reused.
  const path = roundTripVirtualPath(opened.actor.scopes, file.rootName, `/${file.path}`);
  if (path === null) throw new WopiError(404);
  await requireOfficeEdit(deps, opened.actor, path);
  return { ...opened, file, path };
}
