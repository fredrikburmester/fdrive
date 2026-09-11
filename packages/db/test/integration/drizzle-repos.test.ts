import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createOfficeFileRepo, type Db, migrate } from "../../src/index.js";
import { createRepos } from "../../src/repos/drizzle.js";
import { favorites, fileTags, folderViews, recents } from "../../src/schema/app.js";
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

const wildcardPrefixes = [
  { label: "percent", source: "/literal%folder", sibling: "/literalXfolder" },
  { label: "underscore", source: "/literal_folder", sibling: "/literalXfolder" },
  { label: "backslash", source: String.raw`/literal\folder`, sibling: "/literalfolder" },
] as const;

async function seedMetadataPaths(identityId: string, accountId: string, paths: readonly string[]) {
  const repos = createRepos(db);
  const tag = await repos.tags.create(accountId, { name: "prefix-test", color: null });
  for (const path of paths) {
    await Promise.all([
      repos.fileTags.setTags(identityId, path, [tag.id]),
      repos.favorites.add(identityId, path, "file"),
      repos.folderViews.set(identityId, path, "list"),
      repos.recents.touch(identityId, path),
    ]);
  }
}

async function metadataPaths(identityId: string): Promise<Record<string, string[]>> {
  const rows = await Promise.all([
    db.select({ path: fileTags.path }).from(fileTags).where(eq(fileTags.identityId, identityId)),
    db.select({ path: favorites.path }).from(favorites).where(eq(favorites.identityId, identityId)),
    db
      .select({ path: folderViews.path })
      .from(folderViews)
      .where(eq(folderViews.identityId, identityId)),
    db.select({ path: recents.path }).from(recents).where(eq(recents.identityId, identityId)),
  ]);
  return Object.fromEntries(
    ["fileTags", "favorites", "folderViews", "recents"].map((name, index) => [
      name,
      (rows[index] ?? []).map((row) => row.path).sort(),
    ]),
  );
}

describe("metadata prefix operations", () => {
  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        app.file_tags,
        app.favorites,
        app.folder_views,
        app.recents,
        app.tags,
        app.identities,
        app.accounts,
        app.providers
      cascade
    `);
  });

  async function createIdentity(label: string) {
    const repos = createRepos(db);
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: `http://prefix-${label}`,
    });
    const account = await repos.accounts.create({ displayName: label });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: label,
    });
    return { account, identity, repos };
  }

  it.each(wildcardPrefixes)(
    "moves a $label path prefix literally across every metadata repository",
    async ({ label, source, sibling }) => {
      const { account, identity, repos } = await createIdentity(`move-${label}`);
      const target = `/moved-${label}`;
      await seedMetadataPaths(identity.id, account.id, [
        source,
        `${source}/child`,
        sibling,
        `${sibling}/child`,
      ]);

      await Promise.all([
        repos.fileTags.movePrefix(identity.id, source, target, true),
        repos.favorites.movePrefix(identity.id, source, target, true),
        repos.folderViews.movePrefix(identity.id, source, target, true),
        repos.recents.movePrefix(identity.id, source, target, true),
      ]);

      const expected = [target, `${target}/child`, sibling, `${sibling}/child`].sort();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: expected,
        favorites: expected,
        folderViews: expected,
        recents: expected,
      });
    },
  );

  it.each(wildcardPrefixes)(
    "deletes a $label path prefix literally across every metadata repository",
    async ({ label, source, sibling }) => {
      const { account, identity, repos } = await createIdentity(`delete-${label}`);
      await seedMetadataPaths(identity.id, account.id, [
        source,
        `${source}/child`,
        sibling,
        `${sibling}/child`,
      ]);

      await Promise.all([
        repos.fileTags.deletePrefix(identity.id, source, true),
        repos.favorites.deletePrefix(identity.id, source, true),
        repos.folderViews.deletePrefix(identity.id, source, true),
        repos.recents.deletePrefix(identity.id, source, true),
      ]);

      const expected = [sibling, `${sibling}/child`].sort();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: expected,
        favorites: expected,
        folderViews: expected,
        recents: expected,
      });
    },
  );
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
