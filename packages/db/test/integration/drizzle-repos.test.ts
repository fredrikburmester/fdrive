import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { createDb, type Db, migrate } from "../../src/index.js";
import { createRepos } from "../../src/repos/drizzle.js";
import { defineReposSuite } from "../repos-suite.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();

  const created = createDb(container.getConnectionUri());
  db = created.db;
  close = created.close;
  await migrate(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

defineReposSuite("drizzle", async () => {
  await db.execute(sql`
    truncate table
      app.sessions,
      app.credentials,
      app.identities,
      app.accounts,
      app.providers,
      app.settings
    cascade
  `);
  return createRepos(db);
});
