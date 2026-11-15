import { isOfficePath } from "@fdrive/contracts";
import { z } from "zod";
import { hashSessionId } from "../auth/sessions.js";
import { WopiError } from "./errors.ts";
import type { OfficeClaims } from "./tokens.ts";
import type { BrowserOfficeInput, OfficeActor, OfficeDeps, OpenedFile } from "./types.ts";

export async function officeActor(
  deps: OfficeDeps,
  sessionHash: string,
  identityId: string,
): Promise<OfficeActor> {
  const now = deps.clock();
  const session = await deps.repos.sessions.getByIdHash(sessionHash, now);
  if (session === null || session.expiresAt <= now || session.identityId !== identityId)
    throw new WopiError(401);
  const identity = await deps.repos.identities.get(identityId);
  if (identity === null) throw new WopiError(401);
  return { identity, session, storage: await deps.storageFactory(identity.id) };
}
export async function browserActor(
  deps: OfficeDeps,
  input: BrowserOfficeInput,
): Promise<OfficeActor> {
  return officeActor(deps, hashSessionId(input.sessionId), input.principal.identityId);
}
export async function callbackFile(
  deps: OfficeDeps,
  fileId: string,
  claims: OfficeClaims,
): Promise<OpenedFile> {
  if (!z.uuid().safeParse(fileId).success || claims.sub !== fileId) throw new WopiError(401);
  const actor = await officeActor(deps, claims.sessionHash, claims.identityId);
  const file = await deps.files.get(fileId);
  if (file === null) throw new WopiError(404);
  // Where the document lies for this login now: its owner's path, or under
  // `Shared with me` while a folder holding it is shared with the login.
  const path = await deps.grants.pathFor(actor.identity.id, file);
  if (path === null) throw new WopiError(404);
  const stat = await actor.storage.statFile(path);
  const editAllowed = await canEditOfficeFile(deps, actor, path);
  return {
    actor,
    file,
    path,
    stat,
    editAllowed,
    mode: claims.mode === "edit" && editAllowed ? "edit" : "view",
  };
}

/** Explicit operator admission is independent of browser intent and storage read access. */
export async function canEditOfficeFile(
  deps: OfficeDeps,
  actor: OfficeActor,
  path: string,
): Promise<boolean> {
  if (!isOfficePath(path)) return false;
  try {
    return (await deps.canEdit?.(actor, path)) === true;
  } catch {
    return false;
  }
}

export async function requireOfficeEdit(
  deps: OfficeDeps,
  actor: OfficeActor,
  path: string,
): Promise<void> {
  if (!(await canEditOfficeFile(deps, actor, path))) throw new WopiError(403);
}
