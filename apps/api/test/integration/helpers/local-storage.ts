import { createDb, createRepos, migrate, type Repos } from "@fdrive/db";
import { insertLocalUsers, type LocalUserRepos, type LocalUserSeed } from "@fdrive/testkit";
import type { Logger } from "pino";
import { createScryptSharePasswords } from "../../../src/shares/passwords.js";

/**
 * `insertLocalUsers`' repos over `repos`: each user comes with their account
 * and login on the files folder's row, created here as the API's
 * `seedFromEnvironment` creates it, which adopts it when it starts.
 */
export async function localUserRepos(repos: Repos): Promise<LocalUserRepos> {
  const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  return {
    localUsers: {
      create: (user) =>
        repos.logins.createUser({
          ...user,
          providerId: provider.id,
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
 * `startLocalStorage` fixture to create the users it was laid out for.
 */
export async function seedLocalUsers(connectionString: string, seed: LocalUserSeed): Promise<void> {
  const database = createDb(connectionString);
  try {
    await migrate(database.db);
    await insertLocalUsers(
      await localUserRepos(createRepos(database.db)),
      seed,
      createScryptSharePasswords(),
    );
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
