import {
  insertLocalUsers,
  type LocalUserRepos,
  type SeedGrant,
  type SeedUser,
} from "@fdrive/testkit";
import { Client } from "pg";
import { createScryptSharePasswords } from "../../../api/src/shares/passwords.ts";

/**
 * `app.local_users` and `app.local_grants` written with plain SQL: the web
 * app does not depend on `@fdrive/db`, and these are the same rows its
 * repos would write.
 */
function sqlRepos(client: Client): LocalUserRepos {
  return {
    localUsers: {
      create: ({ username, passwordHash }) =>
        client.query("insert into app.local_users (username, password_hash) values ($1, $2)", [
          username,
          passwordHash,
        ]),
      update: (username, { disabled }) =>
        client.query(
          "update app.local_users set disabled = $2, updated_at = now() where username = $1",
          [username, disabled],
        ),
    },
    localGrants: {
      put: ({ ownerUsername, path, granteeUsername, access }) =>
        client.query(
          `insert into app.local_grants (owner_username, path, grantee_username, access)
           values ($1, $2, $3, $4)
           on conflict (owner_username, path, grantee_username) do update set access = excluded.access`,
          [ownerUsername, path, granteeUsername, access],
        ),
    },
  };
}

/**
 * Creates the local folder's users, their passwords hashed exactly as the
 * API checks them at sign-in, and the folders they share with each other:
 * what setup and System > Users would have done. Needs the API to have
 * migrated the database first.
 */
export async function createE2eLocalUsers(
  databaseUrl: string,
  seed: { readonly users: readonly SeedUser[]; readonly grants?: readonly SeedGrant[] },
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await insertLocalUsers(sqlRepos(client), seed, createScryptSharePasswords());
  } finally {
    await client.end();
  }
}
