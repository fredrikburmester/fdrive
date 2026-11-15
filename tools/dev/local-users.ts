/**
 * Creates users of the api's local folder directly, each with their account
 * and login, for the dev environment (`seed-users.ts`) and the perf fixture.
 * Real installations create them through setup and System > Users.
 */
import { ConflictError, type Repos } from "@fdrive/db";
import {
  createScryptSharePasswords,
  type SharePasswords,
} from "../../apps/api/src/shares/passwords.ts";

/** A user to create, with the password it signs in with. */
export interface LocalUserSeed {
  readonly username: string;
  readonly password: string;
  /** Gives the user an administrator account, also when the user exists already. */
  readonly isAdmin?: boolean;
}

/**
 * Creates each of `users` that does not exist yet, with their account and
 * login on the files folder's row (created here as the api creates it on
 * start), its password hashed the way the api checks it at sign-in (scrypt,
 * `scrypt$N$r$p$salt$key`). A user that exists keeps its password and state,
 * except that one marked `isAdmin` becomes an administrator. Returns the
 * usernames it created, in order.
 */
export async function seedLocalUsers(
  repos: Pick<Repos, "localUsers" | "logins" | "providers">,
  users: readonly LocalUserSeed[],
  passwords: Pick<SharePasswords, "hash"> = createScryptSharePasswords(),
): Promise<string[]> {
  const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const created: string[] = [];
  for (const user of users) {
    if ((await repos.localUsers.get(user.username)) !== null) {
      if (user.isAdmin === true) {
        await repos.logins.updateUser(user.username, { isAdmin: true, at: new Date() });
      }
      continue;
    }
    try {
      await repos.logins.createUser({
        providerId: provider.id,
        username: user.username,
        passwordHash: await passwords.hash(user.password),
        isAdmin: user.isAdmin === true,
        at: new Date(),
      });
      created.push(user.username);
    } catch (error) {
      // Another run created it in between; it is there either way.
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  return created;
}
