import { isOfficePath } from "@fdrive/contracts";
import { scopesFor, toVirtualPath } from "@fdrive/core";
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
  if (session === null || session.expiresAt <= now) throw new WopiError(401);
  const identity = await deps.repos.identities.get(identityId);
  if (
    identity === null ||
    identity.accountId !== session.accountId ||
    (await deps.repos.accounts.get(session.accountId)) === null
  )
    throw new WopiError(401);
  const location = await deps.location();
  if (location === null || location.providerId !== identity.providerId) throw new WopiError(401);
  return {
    identity,
    session,
    homeTemplate: location.homeTemplate,
    storage: await deps.storageFactory(identity.id, identity.providerId),
  };
}
export async function browserActor(
  deps: OfficeDeps,
  input: BrowserOfficeInput,
): Promise<OfficeActor> {
  const actor = await officeActor(deps, hashSessionId(input.sessionId), input.principal.identityId);
  if (actor.session.accountId !== input.principal.accountId) throw new WopiError(401);
  return actor;
}
export async function callbackFile(
  deps: OfficeDeps,
  fileId: string,
  claims: OfficeClaims,
): Promise<OpenedFile> {
  if (!z.uuid().safeParse(fileId).success || claims.sub !== fileId) throw new WopiError(401);
  const actor = await officeActor(deps, claims.sessionHash, claims.identityId);
  const file = await deps.files.get(fileId);
  if (file === null || file.providerId !== actor.identity.providerId) throw new WopiError(404);
  const path = toVirtualPath(
    scopesFor({ template: actor.homeTemplate, username: actor.identity.externalUsername }),
    file.rootName,
    `/${file.path}`,
  );
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
