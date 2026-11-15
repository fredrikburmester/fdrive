import type { LocalGrantRepo, LocalUserRepo } from "@fdrive/db";
import type { LocalUsers } from "@fdrive/local";
import type { SharePasswords } from "../shares/passwords.js";

/**
 * What checking a local user's password comes to. `ok` carries the name as
 * stored, which may have been typed in another case.
 */
export type LocalUserCheck =
  | { readonly result: "ok"; readonly username: string }
  | { readonly result: "invalid" | "disabled" };

/** The files folder's view of the users, plus the password check fdrive itself makes. */
export interface LocalUserStore extends LocalUsers {
  verify(username: string, password: string): Promise<LocalUserCheck>;
}

export interface LocalUserStoreDeps {
  readonly repo: LocalUserRepo;
  readonly grants: Pick<LocalGrantRepo, "listReceived">;
  readonly passwords: SharePasswords;
}

/**
 * The files folder's view of `app.local_users` and `app.local_grants`: is
 * this user still active, what do others share with them.
 */
export function createLocalUsers(deps: Pick<LocalUserStoreDeps, "repo" | "grants">): LocalUsers {
  return {
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
  };
}

/**
 * The users as fdrive itself reads them: the module's view, and whether a
 * password is right. A name nobody has still costs one password check, so
 * how long a sign-in takes does not tell which usernames exist.
 */
export function createLocalUserStore(deps: LocalUserStoreDeps): LocalUserStore {
  let decoy: Promise<string> | undefined;
  const decoyHash = () => {
    decoy ??= deps.passwords.hash("fdrive decoy password");
    return decoy;
  };

  return {
    ...createLocalUsers(deps),
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
  };
}
