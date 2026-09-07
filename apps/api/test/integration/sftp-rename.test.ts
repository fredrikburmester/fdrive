import { performance } from "node:perf_hooks";
import { parseHomeTemplate, type StorageProvider, scopesFor } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BusEvent, createEventBus } from "../../src/events/bus.js";
import {
  createIndexerListener,
  createPgNotificationClient,
} from "../../src/events/indexer-listener.js";
import { createMetadataService } from "../../src/metadata/service.js";
import { createSftpgoStorageProvider } from "../../src/storage/sftpgo-provider.js";
import { SftpIndexerStack } from "./helpers/sftp-indexer-stack.js";

const SFTP_PASSWORD = "disposable-test-password";

function byPath<T extends { path: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

describe("external SFTP directory rename through the real indexer", () => {
  const stack = new SftpIndexerStack();
  let connection: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await stack.startDatabaseAndStorage();
    connection = createDb(stack.connectionString);
    await migrate(connection.db);
    await stack.startIndexer();
  }, 720_000);

  afterAll(async () => {
    try {
      await connection?.close();
    } finally {
      await stack.stop();
    }
  }, 180_000);

  it("moves directory and descendant tags, favorites and recents without crossing sibling or identity boundaries", async () => {
    const { db } = connection;
    const repos = createRepos(db);
    const metadata = createMetadataService(repos);
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: stack.sftpgoUrl });
    const alice = await repos.accounts.create({ displayName: "Alice" });
    const other = await repos.accounts.create({ displayName: "Alice Other" });
    const identity = await repos.identities.create({
      accountId: alice.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const otherIdentity = await repos.identities.create({
      accountId: other.id,
      providerId: provider.id,
      externalUsername: "alice-other",
    });
    const tag = await metadata.createTag(alice.id, { name: "Work", color: null });
    const otherTag = await metadata.createTag(other.id, { name: "Private", color: null });
    const movedPaths = ["/docs", "/docs/top.dat", "/docs/nested", "/docs/nested/child.dat"];
    const siblingPath = "/docs-other/keep.dat";
    for (const path of [...movedPaths, siblingPath]) {
      await metadata.setFileTags(identity.id, path, [tag.id]);
      await metadata.addFavorite(identity.id, path, path.endsWith(".dat") ? "file" : "dir");
      if (path.endsWith(".dat")) await metadata.touchRecent(identity.id, path);
    }
    for (const path of ["/docs", "/docs/top.dat"]) {
      await metadata.setFileTags(otherIdentity.id, path, [otherTag.id]);
      await metadata.addFavorite(otherIdentity.id, path, path.endsWith(".dat") ? "file" : "dir");
    }
    await metadata.touchRecent(otherIdentity.id, "/docs/top.dat");
    const originalRecents = await metadata.listRecents(identity.id);
    const originalFavorites = await metadata.listFavorites(identity.id);
    const otherRecents = await metadata.listRecents(otherIdentity.id);
    const otherFavorites = await metadata.listFavorites(otherIdentity.id);
    await expect
      .poll(
        async () => {
          const rows = await db.execute(
            sql`select path from idx.files where deleted_at is null order by path`,
          );
          return rows.rows.map((row) => String(row.path)).sort();
        },
        { timeout: 30_000, interval: 100 },
      )
      .toEqual([
        "alice-other/docs/top.dat",
        "alice/docs-other/keep.dat",
        "alice/docs/nested/child.dat",
        "alice/docs/top.dat",
      ]);
    const before = await db.execute(
      sql`select id, path from idx.files where deleted_at is null order by id`,
    );
    const bus = createEventBus();
    const received: BusEvent[] = [];
    const otherReceived: BusEvent[] = [];
    const warnings: string[] = [];
    bus.subscribe({ identityId: identity.id }, (event) => received.push(event));
    bus.subscribe({ identityId: otherIdentity.id }, (event) => otherReceived.push(event));
    const homeTemplate = parseHomeTemplate("sftpgo:/{username}");
    // Live storage per identity, against the real SFTPGo container: the
    // listener's live-read check before announcing a move destination must
    // pass against the identity's actual storage, not a stub.
    const sftpgoClient = createSftpgoClient({ baseUrl: stack.sftpgoUrl, fetch: globalThis.fetch });
    const storageByIdentityId = new Map<string, StorageProvider>();
    for (const [id, username] of [
      [identity.id, "alice"],
      [otherIdentity.id, "alice-other"],
    ] as const) {
      const token = await sftpgoClient.login({ username, password: SFTP_PASSWORD });
      storageByIdentityId.set(
        id,
        createSftpgoStorageProvider({
          client: sftpgoClient,
          withToken: async (fn) => fn(token.accessToken),
        }),
      );
    }
    const listener = createIndexerListener({
      createClient: () => createPgNotificationClient(stack.connectionString),
      identities: repos.identities,
      indexQueries: createIndexQueries(db),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus,
      configuredMappingsFor: async (id) => ({
        available: true,
        providerId: id.providerId,
        homeTemplateRaw: "sftpgo:/{username}",
        scopes: scopesFor({ template: homeTemplate, username: id.externalUsername }),
      }),
      storageForIdentity: async (id) => {
        const storage = storageByIdentityId.get(id);
        if (storage === undefined) throw new Error(`no storage seeded for identity ${id}`);
        return storage;
      },
      indexRootNames: new Set(["sftpgo"]),
      clock: () => new Date(),
      logger: { warn: (_data, message) => warnings.push(message) },
    });
    await listener.start();
    try {
      const started = performance.now();
      // This is the only mutation trigger. The indexer itself records and publishes the move.
      await stack.renameDirectory();
      await expect
        .poll(() => received.filter((event) => event.type === "fs" && event.op === "move"), {
          timeout: 10_000,
          interval: 100,
        })
        .toMatchObject([{ identityId: identity.id, paths: ["/docs"], targetPaths: ["/renamed"] }]);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(10_000);
      console.info(`SFTP rename -> indexer -> API metadata: ${Math.round(elapsed)} ms`);
      const rename = (path: string) =>
        path === "/docs" || path.startsWith("/docs/")
          ? `/renamed${path.slice("/docs".length)}`
          : path;
      expect((await metadata.filesForTag(identity.id, tag.id)).sort()).toEqual(
        [...movedPaths, siblingPath].map(rename).sort(),
      );
      expect(byPath(await metadata.listFavorites(identity.id))).toEqual(
        byPath(originalFavorites.map((item) => ({ ...item, path: rename(item.path) }))),
      );
      expect(await metadata.listRecents(identity.id)).toEqual(
        originalRecents.map((item) => ({ ...item, path: rename(item.path) })),
      );
      expect((await metadata.filesForTag(otherIdentity.id, otherTag.id)).sort()).toEqual([
        "/docs",
        "/docs/top.dat",
      ]);
      expect(byPath(await metadata.listFavorites(otherIdentity.id))).toEqual(
        byPath(otherFavorites),
      );
      expect(await metadata.listRecents(otherIdentity.id)).toEqual(otherRecents);
      expect(otherReceived).toEqual([]);
      expect(warnings).toEqual([]);
      const after = await db.execute(
        sql`select id, path from idx.files where deleted_at is null order by id`,
      );
      expect(after.rows).toEqual(
        before.rows.map((row) => ({
          ...row,
          path: String(row.path).replace(/^alice\/docs\//, "alice/renamed/"),
        })),
      );
      const moves = await db.execute(sql`select src, dst, actor from idx.moves`);
      expect(moves.rows).toEqual([{ src: "alice/docs", dst: "alice/renamed", actor: "watcher" }]);
      const events = await db.execute(
        sql`select path, target_path from idx.events where kind = 'moved'`,
      );
      expect(events.rows).toEqual([{ path: "alice/docs", target_path: "alice/renamed" }]);
    } catch (error) {
      console.error(await stack.logs());
      throw error;
    } finally {
      await listener.stop();
    }
  });
});
