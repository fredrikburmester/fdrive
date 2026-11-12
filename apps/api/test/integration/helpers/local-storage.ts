import { createDb, createRepos, migrate } from "@fdrive/db";
import { insertLocalUsers, type LocalUserSeed } from "@fdrive/testkit";
import type { Logger } from "pino";
import { createScryptSharePasswords } from "../../../src/shares/passwords.js";

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
    await insertLocalUsers(createRepos(database.db), seed, createScryptSharePasswords());
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
