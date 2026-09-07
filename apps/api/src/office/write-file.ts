import { scopesFor, toFsPath, toVirtualPath } from "@fdrive/core";
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
  const scopes = scopesFor({
    template: opened.actor.homeTemplate,
    username: opened.actor.identity.externalUsername,
  });
  const path = toVirtualPath(scopes, file.rootName, `/${file.path}`);
  if (path === null) throw new WopiError(404);
  const mapped = toFsPath(scopes, path);
  if (mapped === null || mapped.rootName !== file.rootName || mapped.fsPath.slice(1) !== file.path)
    throw new WopiError(404);
  await requireOfficeEdit(deps, opened.actor, path);
  return { ...opened, file, path };
}
