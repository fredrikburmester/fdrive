import type { LocalGrantRepo, LocalUserRepo } from "@fdrive/db";
import type { LocalUsers } from "@fdrive/local";
import type { SharePasswords } from "../shares/passwords.js";
import type { HomeUsage } from "../storage/usage.js";

export interface LocalUserStoreDeps {
  readonly repo: LocalUserRepo;
  readonly grants: Pick<LocalGrantRepo, "listReceived">;
  readonly passwords: SharePasswords;
  /** What each home holds; with it, storage limits are enforced (`room`). */
  readonly usage?: HomeUsage;
}

/**
 * The local module's view of `app.local_users` and `app.local_grants`: is
 * this password right, is this user still active, what do others share
 * with them, how much more may their folder hold. A name nobody has still
 * costs one password check, so how long a sign-in takes does not tell which
 * usernames exist.
 */
export function createLocalUserStore(deps: LocalUserStoreDeps): LocalUsers {
  const { usage } = deps;
  let decoy: Promise<string> | undefined;
  const decoyHash = () => {
    decoy ??= deps.passwords.hash("fdrive decoy password");
    return decoy;
  };

  return {
    async verify(username, password) {
      const user = await deps.repo.get(username);
      if (user === null) {
        await deps.passwords.verify(password, await decoyHash());
        return { result: "invalid" };
      }
      if (!(await deps.passwords.verify(password, user.passwordHash))) return { result: "invalid" };
      // A disabled user learns so only with the right password.
      return user.disabled ? { result: "disabled" } : { result: "ok", username: user.username };
    },
    async status(username) {
      const user = await deps.repo.get(username);
      if (user === null) return "missing";
      return user.disabled ? "disabled" : "active";
    },
    async shared(username) {
      return (await deps.grants.listReceived(username)).map((grant) => ({
        owner: grant.ownerUsername,
        path: grant.path,
        writable: grant.access === "write",
      }));
    },
    ...(usage === undefined
      ? {}
      : {
          async room(username: string) {
            const user = await deps.repo.get(username);
            if (user === null || user.storageLimit === null) return null;
            // A folder the index does not hold yet counts as empty.
            return user.storageLimit - ((await usage(user.username)) ?? 0);
          },
        }),
  };
}
