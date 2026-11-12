import type { LocalUserRepo } from "@fdrive/db";
import type { LocalUsers } from "@fdrive/local";
import type { SharePasswords } from "../shares/passwords.js";

export interface LocalUserStoreDeps {
  readonly repo: LocalUserRepo;
  readonly passwords: SharePasswords;
}

/**
 * The local module's view of `app.local_users`: is this password right, is
 * this user still active. A name nobody has still costs one password check,
 * so how long a sign-in takes does not tell which usernames exist.
 */
export function createLocalUserStore(deps: LocalUserStoreDeps): LocalUsers {
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
  };
}
