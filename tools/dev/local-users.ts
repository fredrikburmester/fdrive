/**
 * Creates users of the api's local folder directly in `app.local_users`,
 * for the dev environment (`seed-users.ts`) and the perf fixture. Real
 * installations create them through setup and System > Users.
 */
import type { LocalUserRepo } from "@fdrive/db";
import { ConflictError } from "@fdrive/db";
import {
  createScryptSharePasswords,
  type SharePasswords,
} from "../../apps/api/src/shares/passwords.ts";

/** A user to create, with the password it signs in with. */
export interface LocalUserSeed {
  readonly username: string;
  readonly password: string;
}

/**
 * Creates each of `users` that does not exist yet, its password hashed the
 * way the api checks it at sign-in (scrypt, `scrypt$N$r$p$salt$key`). A user
 * that exists keeps its password and state. Returns the usernames it
 * created, in order.
 */
export async function seedLocalUsers(
  repo: Pick<LocalUserRepo, "get" | "create">,
  users: readonly LocalUserSeed[],
  passwords: Pick<SharePasswords, "hash"> = createScryptSharePasswords(),
): Promise<string[]> {
  const created: string[] = [];
  for (const user of users) {
    if ((await repo.get(user.username)) !== null) continue;
    try {
      await repo.create({
        username: user.username,
        passwordHash: await passwords.hash(user.password),
      });
      created.push(user.username);
    } catch (error) {
      // Another run created it in between; it is there either way.
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  return created;
}
