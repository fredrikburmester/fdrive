/**
 * Creates the dev users (alice, bob, carol and dev, see `generate-seed.ts`)
 * in `app.local_users`, so they sign in to the api dev server's local folder
 * with their known passwords. Run with `pnpm dev:users`, which `pnpm dev:env`
 * also runs; it reads `DATABASE_URL` from apps/api/.env.dev and applies the
 * same migrations the api runs on start. A user that already exists keeps its
 * password and state, so running it again changes nothing.
 *
 * Once a local user exists, a fresh database counts as set up and the setup
 * wizard is skipped: sign in as dev/dev, an administrator through
 * FDRIVE_ADMIN_USERS.
 */
import { createDb, createRepos, migrate } from "@fdrive/db";
import { devUsers } from "./generate-seed.js";
import { seedLocalUsers } from "./local-users.js";

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set; run `pnpm dev:env` first to write apps/api/.env.dev");
  }
  const database = createDb(databaseUrl, { max: 2 });
  try {
    await migrate(database.db);
    const users = devUsers();
    const created = await seedLocalUsers(createRepos(database.db).localUsers, users);
    const kept = users.map((user) => user.username).filter((name) => !created.includes(name));
    console.log(
      [
        created.length > 0 ? `Created local users: ${created.join(", ")}` : "",
        kept.length > 0 ? `already present: ${kept.join(", ")}` : "",
      ]
        .filter((part) => part !== "")
        .join("; "),
    );
  } finally {
    await database.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main(process.env);
}
