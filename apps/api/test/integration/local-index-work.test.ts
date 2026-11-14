import { createHash } from "node:crypto";
import type { StorageProvider, StorageSession } from "@fdrive/core";
import {
  createDb,
  createIndexQueries,
  createIndexWorkWriter,
  createRepos,
  migrate,
} from "@fdrive/db";
import { createLocalModule, type IndexChange, type LocalUsers } from "@fdrive/local";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIndexWorkQueue, type IndexWorkQueue } from "../../src/local/index-work.js";
import { LocalIndexerStack } from "./helpers/local-indexer-stack.js";

const users: LocalUsers = {
  verify: async () => ({ result: "invalid" }),
  status: async () => "active",
  shared: async () => [],
};

function session(externalUsername: string): StorageSession {
  return {
    externalUsername,
  };
}

/**
 * The watcher is off and the next scan is an hour away, so anything indexed
 * within seconds reached the indexer through `idx.work`.
 */
describe("changes fdrive makes, through the real indexer with its watcher off", () => {
  const stack = new LocalIndexerStack();
  let connection: ReturnType<typeof createDb>;
  let queue: IndexWorkQueue;
  let storage: StorageProvider;
  const failures: unknown[] = [];

  beforeAll(async () => {
    await stack.startDatabaseAndStorage();
    connection = createDb(stack.connectionString);
    await migrate(connection.db);
    // Text search reads plain text itself, so no ml service is needed.
    await createRepos(connection.db).settings.set("features.configuration", {
      version: 1,
      revision: 1,
      walkthroughComplete: true,
      values: {
        thumbnails: false,
        textSearch: true,
        searchOcr: false,
        semanticSearch: false,
        imageSearch: false,
        pdfOcr: false,
      },
    });
    await stack.startIndexer({ watch: false });
    queue = createIndexWorkQueue({
      write: createIndexWorkWriter(connection.db),
      onError: (error) => failures.push(error),
    });
    const module = createLocalModule({
      root: stack.folder.root,
      users,
      indexRoot: "files",
      onIndexChange: (root, change) => queue.record(root, change),
    });
    storage = module.createStorage({ id: "p1", baseUrl: "local", config: {} }, session("alice"), {
      fetch: globalThis.fetch,
    });
  }, 720_000);

  afterAll(async () => {
    try {
      await connection?.close();
    } finally {
      await stack.stop();
    }
  }, 180_000);

  async function notes(): Promise<{ path: string; sha256: string | null; status: string }[]> {
    const result = await connection.db.execute(
      sql`select path, sha256, text_status from idx.files
          where path like 'alice/notes/%' and deleted_at is null order by path`,
    );
    return result.rows.map((row) => ({
      path: String(row.path),
      sha256: row.sha256 === null ? null : String(row.sha256),
      status: String(row.text_status),
    }));
  }

  /**
   * Queues `change` once more after the indexer's container sees `paths` as
   * given. A queued change is applied to what is on disk, and Docker Desktop
   * can show the container this host's folder as it was a moment ago; on a
   * Linux host the first one already did it. A change queued twice is
   * harmless.
   */
  async function settle(change: IndexChange, paths: Record<string, boolean>): Promise<void> {
    await queue.flush();
    for (const [path, present] of Object.entries(paths)) await stack.seen(path, present);
    queue.record("files", change);
    await queue.flush();
  }

  async function count(table: "idx.scans" | "idx.work"): Promise<number> {
    const result = await connection.db.execute(
      sql`select count(*)::int as n from ${sql.raw(table)}`,
    );
    return Number(result.rows[0]?.n);
  }

  it("indexes an upload, follows its move and drops it once deleted, within seconds", async () => {
    const scans = await count("idx.scans");
    const bytes = new TextEncoder().encode("quarterly invoice from the harbour office");
    await storage.upload("/notes/invoice.txt", bytes, { mkdirParents: true });
    await queue.flush();
    await expect.poll(notes, { timeout: 15_000, interval: 100 }).toEqual([
      {
        path: "alice/notes/invoice.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        // Chunked without vectors while semantic search is off.
        status: "partial",
      },
    ]);
    const hits = await connection.db.execute(
      sql`select f.path from idx.chunks c join idx.files f on f.id = c.file_id
          where c.tsv @@ plainto_tsquery('simple', 'harbour')`,
    );
    expect(hits.rows.map((row) => row.path)).toEqual(["alice/notes/invoice.txt"]);

    await storage.move("/notes/invoice.txt", "/notes/renamed.txt");
    await settle(
      { kind: "moved", path: "alice/notes/invoice.txt", target: "alice/notes/renamed.txt" },
      { "alice/notes/invoice.txt": false, "alice/notes/renamed.txt": true },
    );
    await expect
      .poll(async () => (await notes()).map((row) => row.path), { timeout: 15_000, interval: 100 })
      .toEqual(["alice/notes/renamed.txt"]);

    await storage.deleteFile("/notes/renamed.txt");
    await settle(
      { kind: "changed", path: "alice/notes/renamed.txt" },
      { "alice/notes/renamed.txt": false },
    );
    await expect.poll(notes, { timeout: 15_000, interval: 100 }).toEqual([]);

    const events = await connection.db.execute(
      sql`select kind from idx.events where path like 'alice/notes/%' order by id`,
    );
    expect(events.rows.map((row) => row.kind)).toEqual(["created", "moved", "deleted"]);
    await expect.poll(() => count("idx.work"), { timeout: 15_000, interval: 100 }).toBe(0);
    expect(await count("idx.scans")).toBe(scans);
    expect(failures).toEqual([]);
  });

  it("records a new folder, empty or not, so search finds it by name within seconds", async () => {
    const scans = await count("idx.scans");
    const queries = createIndexQueries(connection.db);
    const roots = await queries.rootIdsByName();
    const scope = [{ rootId: roots.files ?? -1, fsPrefix: "/alice" }];
    const found = async () =>
      (await queries.folders(scope, ["microlä"], "Microlä", 10)).map((row) =>
        row.path.normalize("NFC"),
      );

    await storage.mkdir("/Kurser/Microlärande", { parents: true });
    await settle({ kind: "changed", path: "alice/Kurser" }, { "alice/Kurser/Microlärande": true });
    await expect
      .poll(found, { timeout: 15_000, interval: 100 })
      .toEqual(["alice/Kurser/Microlärande"]);

    await storage.move("/Kurser/Microlärande", "/Microlärande 2026");
    await settle(
      { kind: "moved", path: "alice/Kurser/Microlärande", target: "alice/Microlärande 2026" },
      { "alice/Kurser/Microlärande": false, "alice/Microlärande 2026": true },
    );
    await expect
      .poll(found, { timeout: 15_000, interval: 100 })
      .toEqual(["alice/Microlärande 2026"]);

    await storage.deleteDir("/Microlärande 2026");
    await settle(
      { kind: "changed", path: "alice/Microlärande 2026" },
      { "alice/Microlärande 2026": false },
    );
    await expect.poll(found, { timeout: 15_000, interval: 100 }).toEqual([]);
    expect(await count("idx.scans")).toBe(scans);
    expect(failures).toEqual([]);
  });
});
