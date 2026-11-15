import { createDb, createRepos, migrate, type Repos } from "@fdrive/db";
import { insertLocalUsers, type LocalUserRepos, type LocalUserSeed } from "@fdrive/testkit";
import type { Logger } from "pino";
import { createScryptSharePasswords } from "../../../src/shares/passwords.js";

/** `insertLocalUsers`' repos over `repos`: each user comes with their account and login. */
export function localUserRepos(repos: Repos): LocalUserRepos {
  return {
    localUsers: {
      create: (user) =>
        repos.logins.createUser({
          ...user,
          isAdmin: false,
          at: new Date(),
        }),
      update: (username, patch) => repos.localUsers.update(username, patch),
    },
    localGrants: repos.localGrants,
  };
}

/**
 * Migrates the database at `connectionString` and creates `seed`'s local
 * users and grants in it, hashed the way sign-in checks them: what setup and
 * System > Users would have done before the suite signs anyone in. Pass a
 * `startLocalStorage` fixture to create the users it was laid out for; the
 * users named in `admins` get administrator accounts.
 */
export async function seedLocalUsers(
  connectionString: string,
  seed: LocalUserSeed,
  admins: readonly string[] = [],
): Promise<void> {
  const database = createDb(connectionString);
  try {
    await migrate(database.db);
    const repos = createRepos(database.db);
    await insertLocalUsers(localUserRepos(repos), seed, createScryptSharePasswords());
    for (const username of admins) {
      await repos.logins.updateUser(username, { isAdmin: true, at: new Date() });
    }
  } finally {
    await database.close();
  }
}

/** A logger that drops everything. */
export function silentLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
  } as unknown as Logger;
}
