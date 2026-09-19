import type { ActivityFacts, PersonalActivityAction } from "@fdrive/contracts";
import type { Principal } from "../auth/principal.js";
import type { OfficeActor, OfficeDeps } from "../office/types.js";
import { activityStat } from "./service.js";

/**
 * The authorized browser session behind an editor action, as an actor history
 * can attribute. `verifyAuthority` re-proves the session and its login right
 * before the recorded work, so a revoked session records nothing.
 */
export function officeActivityPrincipal(deps: OfficeDeps, actor: OfficeActor): Principal {
  return {
    accountId: actor.session.accountId,
    identityId: actor.identity.id,
    username: "office",
    isAdmin: false,
    storage: actor.storage,
    verifyAuthority: async () => {
      const [identity, session] = await Promise.all([
        deps.repos.identities.get(actor.identity.id),
        deps.repos.sessions.getByIdHash(actor.session.idHash, deps.clock()),
      ]);
      return (
        identity?.accountId === actor.session.accountId &&
        session?.accountId === actor.session.accountId
      );
    },
  };
}

/**
 * Records opening a document in the editor. Recently opened reads history, so
 * without this an Office open would vanish from it. Editor saves and Save As
 * are a separate producer.
 */
export async function recordOfficeOpen<T>(
  deps: OfficeDeps,
  actor: OfficeActor,
  path: string,
  fileId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  if (!deps.activity) return mutate();
  const result = await deps.activity.run(
    officeActivityPrincipal(deps, actor),
    {
      action: "file.open",
      source: "office",
      requested: { path, kind: "file" },
      bridge: { namespace: "office", externalId: fileId },
    },
    mutate,
  );
  return result.value;
}

/**
 * Records one editor write. The editor reports a save against the document it
 * opened, so the recorded subject is the opened path and the target is where
 * the bytes actually landed. Save As therefore reads as a copy of the original.
 */
export async function recordOfficeAction<T>(
  deps: OfficeDeps,
  actor: OfficeActor,
  action: PersonalActivityAction,
  path: string,
  target: string,
  bridgeId: string | undefined,
  mutate: () => Promise<T>,
  facts: ActivityFacts = {},
): Promise<T> {
  if (!deps.activity) return mutate();
  const before = await activityStat(actor.storage, path);
  const result = await deps.activity.run(
    officeActivityPrincipal(deps, actor),
    {
      action,
      source: "office",
      requested: {
        path,
        targetPath: target,
        ...(action === "file.copy" ? { variant: "save_as" as const } : {}),
      },
      ...(before ? { before } : {}),
      ...(bridgeId ? { bridge: { namespace: "office", externalId: bridgeId } } : {}),
    },
    mutate,
    () => ({ path: target, kind: "file" as const, ...facts }),
  );
  return result.value;
}
