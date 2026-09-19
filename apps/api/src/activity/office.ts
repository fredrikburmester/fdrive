import type { Principal } from "../auth/principal.js";
import type { OfficeActor, OfficeDeps } from "../office/types.js";

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
