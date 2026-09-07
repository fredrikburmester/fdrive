import { parseHomeTemplate, scopesFor } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BusEvent, createEventBus } from "../../src/events/bus.js";
import {
  createIndexerListener,
  createPgNotificationClient,
  type IndexerListenerLogger,
} from "../../src/events/indexer-listener.js";
import { createMetadataService } from "../../src/metadata/service.js";
import { createMemoryStorage } from "../fixtures/memory-storage.js";

function createSilentLogger(): IndexerListenerLogger {
  return { warn: () => undefined };
}

/** Polls `check` every 50ms until it returns `true` or `timeoutMs` elapses. */
async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("indexer listener (real Postgres LISTEN/NOTIFY)", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
  }, 180_000);

  it("moves tags and publishes an SSE move event when a real NOTIFY arrives", async () => {
    const { db, close } = createDb(postgres.connectionString);
    await migrate(db);
    const repos = createRepos(db);
    const indexQueries = createIndexQueries(db);

    try {
      const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://x" });
      const account = await repos.accounts.create({ displayName: "Alice" });
      const identity = await repos.identities.create({
        accountId: account.id,
        providerId: provider.id,
        externalUsername: "alice",
      });
      const tag = await repos.tags.create(account.id, { name: "Work", color: null });
      await repos.fileTags.setTags(identity.id, "/a.txt", [tag.id]);

      const [root] = await db.insert(schema.roots).values({ name: "sftpgo" }).returning();
      if (root === undefined) {
        throw new Error("expected the root insert to return a row");
      }

      const metadata = createMetadataService(repos);
      const bus = createEventBus();
      const received: BusEvent[] = [];
      bus.subscribe({ identityId: identity.id }, (event) => received.push(event));

      const storage = createMemoryStorage({ "/b.txt": "moved contents" });
      const homeTemplate = parseHomeTemplate("sftpgo:/{username}");
      const listener = createIndexerListener({
        createClient: () => createPgNotificationClient(postgres.connectionString),
        identities: repos.identities,
        indexQueries,
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
        storageForIdentity: async () => storage,
        indexRootNames: new Set(["sftpgo"]),
        clock: () => new Date(),
        logger: createSilentLogger(),
      });

      await listener.start();
      try {
        const payload = JSON.stringify({
          kind: "moved",
          root: "sftpgo",
          path: "alice/a.txt",
          target_path: "alice/b.txt",
          at: new Date().toISOString(),
        });
        await db.execute(sql`
          insert into "idx"."events" (root_id, kind, path, target_path)
          values (${root.id}, 'moved', 'alice/a.txt', 'alice/b.txt')
        `);
        await db.execute(sql`select pg_notify('idx_events', ${payload})`);

        await waitUntil(() => received.length > 0);

        expect(received[0]).toMatchObject({
          type: "fs",
          op: "move",
          identityId: identity.id,
          paths: ["/a.txt"],
          targetPaths: ["/b.txt"],
        });

        const tagsAtNewPath = await repos.fileTags.tagsForPaths(identity.id, ["/b.txt"]);
        expect(tagsAtNewPath.get("/b.txt")).toEqual([tag.id]);
        const tagsAtOldPath = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"]);
        expect(tagsAtOldPath.has("/a.txt")).toBe(false);
      } finally {
        await listener.stop();
      }
    } finally {
      await close();
    }
  });
});
