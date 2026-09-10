import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, createOfficeFileRepo, type Db, migrate } from "../../src/index.js";
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
      app.api_tokens,
      app.credentials,
      app.file_tags,
      app.favorites,
      app.folder_views,
      app.recents,
      app.tags,
      app.identities,
      app.accounts,
      app.providers,
      app.settings,
      app.system_events
    cascade
  `);
  return createRepos(db);
});

// Office file rows go with their provider: a provider with no logins but
// past Office documents must still be removable (the FK cascades).
it("cascades office_files when their provider is deleted", async () => {
  await db.execute(sql`truncate table app.office_files, app.providers cascade`);
  const repos = createRepos(db);
  const officeFiles = createOfficeFileRepo(db);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://office" });
  const file = await officeFiles.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/report.docx",
  });
  expect(await officeFiles.get(file.id)).not.toBeNull();
  await repos.providers.delete(provider.id);
  expect(await repos.providers.get(provider.id)).toBeNull();
  expect(await officeFiles.get(file.id)).toBeNull();
});
