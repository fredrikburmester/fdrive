import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGES_CHANNEL,
  type ChangeJournal,
  createChangeJournal,
  createChangeWriter,
  createDb,
  type Db,
  migrate,
} from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;
let journal: ChangeJournal;

interface ChangeRow extends Record<string, unknown> {
  root: string;
  path: string;
  target_path: string | null;
  source: string;
  sha256: string | null;
  size: string | null;
  mtime_ns: string | null;
  inode: string | null;
  ctime_ns: string | null;
}

async function rows(): Promise<ChangeRow[]> {
  const result = await db.execute<ChangeRow>(sql`
    select r.name as root, c.path, c.target_path, c.source, c.sha256, c.size::text,
      c.mtime_ns::text, c.inode::text, c.ctime_ns::text
    from idx.changes c join idx.roots r on r.id = c.root_id order by c.id`);
  return result.rows;
}

async function paths(): Promise<string[]> {
  return (await rows()).map((row) => row.path);
}

async function age(path: string, interval: string): Promise<void> {
  await db.execute(
    sql`update idx.changes set created_at = now() - ${interval}::interval where path = ${path}`,
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const created = createDb(container.getConnectionUri());
  db = created.db;
  close = created.close;
  await migrate(db);
  journal = createChangeJournal(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

beforeEach(async () => {
  await db.execute(
    sql`truncate table idx.changes, idx.change_cursors, idx.roots restart identity cascade`,
  );
});

describe("append", () => {
  it("adds rows under the named root in order, with their source and an upload's content", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('other'), ('files')`);
    await journal.append("files", "api", [
      {
        path: "alice/a.pdf",
        content: {
          sha256: "ab".repeat(32),
          size: 12,
          mtimeNs: 1_700_000_000_123_456_789n,
          // An inode number past the signed range keeps its 64 bits.
          ino: 2n ** 64n - 5n,
          ctimeNs: 1_700_000_001_000_000_001n,
        },
      },
      { path: "alice/old", targetPath: "alice/new" },
    ]);
    await journal.append("files", "scan", [{ path: "alice/gone.txt" }]);
    const none = { sha256: null, size: null, mtime_ns: null, inode: null, ctime_ns: null };
    expect(await rows()).toEqual([
      {
        root: "files",
        path: "alice/a.pdf",
        target_path: null,
        source: "api",
        sha256: "ab".repeat(32),
        size: "12",
        mtime_ns: "1700000000123456789",
        inode: "-5",
        ctime_ns: "1700000001000000001",
      },
      { root: "files", path: "alice/old", target_path: "alice/new", source: "api", ...none },
      { root: "files", path: "alice/gone.txt", target_path: null, source: "scan", ...none },
    ]);
  });

  it("writes nothing for a root the indexer has not created, or for no items", async () => {
    await journal.append("files", "api", [{ path: "alice/a.pdf" }]);
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await journal.append("files", "api", []);
    expect(await rows()).toEqual([]);
  });

  it("refuses a source the journal does not know", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await expect(
      db.execute(
        sql`insert into idx.changes (root_id, path, source) values (1, 'alice/a.txt', 'web')`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: "changes_source" } });
  });

  it("wakes listeners with the root's name once the rows are committed", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    const listener = new Client({ connectionString: container.getConnectionUri() });
    await listener.connect();
    try {
      await listener.query(`listen ${CHANGES_CHANNEL}`);
      const notified = new Promise<{ channel: string; payload: string | undefined }>((resolve) => {
        listener.once("notification", (message) =>
          resolve({ channel: message.channel, payload: message.payload }),
        );
      });
      await journal.append("files", "api", [{ path: "alice/a.txt" }]);
      expect(await notified).toEqual({ channel: "idx_changes", payload: "files" });
      expect(await rows()).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });

  it("waits for a writer that holds the journal's lock, so positions commit in order", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtextextended('idx.changes', 0))");
      let done = false;
      const appended = journal.append("files", "api", [{ path: "alice/a.txt" }]).then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(false);
      await other.query("commit");
      await appended;
      expect(await paths()).toEqual(["alice/a.txt"]);
    } finally {
      await other.end();
    }
  });

  it("goes with its root, cursors included", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await journal.append("files", "api", [{ path: "alice/a.txt" }]);
    await journal.saveCursor("indexer", "files", 1);
    await db.execute(sql`delete from idx.roots where name = 'files'`);
    expect(await rows()).toEqual([]);
    const cursors = await db.execute(sql`select * from idx.change_cursors`);
    expect(cursors.rows).toEqual([]);
  });
});

describe("prune", () => {
  it("drops rows older than 30 days as a prefix and keeps the newest row", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await journal.append("files", "api", [
      { path: "alice/1.txt" },
      { path: "alice/2.txt" },
      { path: "alice/3.txt" },
    ]);
    await age("alice/1.txt", "31 days");
    await age("alice/2.txt", "30 days 1 minute");
    await age("alice/3.txt", "29 days");
    expect(await journal.prune()).toBe(2);
    expect(await paths()).toEqual(["alice/3.txt"]);
    // The journal is never emptied: its oldest row tells what is gone.
    await age("alice/3.txt", "40 days");
    expect(await journal.prune()).toBe(0);
    expect(await paths()).toEqual(["alice/3.txt"]);
    await journal.append("files", "api", [{ path: "alice/4.txt" }]);
    expect(await journal.prune()).toBe(1);
    expect(await paths()).toEqual(["alice/4.txt"]);
  });

  it("drops nothing from an empty or young journal", async () => {
    expect(await journal.prune()).toBe(0);
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await journal.append("files", "api", [{ path: "alice/a.txt" }, { path: "alice/b.txt" }]);
    expect(await journal.prune()).toBe(0);
    expect(await paths()).toEqual(["alice/a.txt", "alice/b.txt"]);
  });

  it("runs before each write of a source's writer", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    const write = createChangeWriter(db, "api");
    await write("files", [{ path: "alice/stale.txt" }, { path: "alice/recent.txt" }]);
    await age("alice/stale.txt", "31 days");
    await write("files", []);
    expect(await paths()).toEqual(["alice/stale.txt", "alice/recent.txt"]);
    await write("files", [{ path: "alice/new.txt" }]);
    expect(await paths()).toEqual(["alice/recent.txt", "alice/new.txt"]);
  });
});

describe("read", () => {
  it("returns a root's rows after a position, oldest first, up to a limit", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files'), ('photos')`);
    await journal.append("files", "api", [
      {
        path: "alice/a.pdf",
        content: {
          sha256: "ab".repeat(32),
          size: 3,
          mtimeNs: 9n,
          ino: 2n ** 64n - 5n,
          ctimeNs: 11n,
        },
      },
    ]);
    await journal.append("photos", "watcher", [{ path: "p.jpg" }]);
    await journal.append("files", "scan", [{ path: "alice/old", targetPath: "alice/new" }]);
    await journal.append("files", "ocr", [{ path: "alice/b.pdf" }]);

    const page = await journal.read("files", 0, 2);
    expect(page.gap).toBe(false);
    expect(page.changes.map(({ createdAt, ...change }) => change)).toEqual([
      {
        position: 1,
        path: "alice/a.pdf",
        targetPath: null,
        source: "api",
        content: {
          sha256: "ab".repeat(32),
          size: 3,
          mtimeNs: 9n,
          ino: 2n ** 64n - 5n,
          ctimeNs: 11n,
        },
      },
      { position: 3, path: "alice/old", targetPath: "alice/new", source: "scan", content: null },
    ]);
    expect(page.changes[0]?.createdAt).toBeInstanceOf(Date);
    const rest = await journal.read("files", 3, 10);
    expect(rest.changes.map((change) => [change.position, change.source])).toEqual([[4, "ocr"]]);
    expect((await journal.read("files", 4, 10)).changes).toEqual([]);
    expect(await journal.read("nowhere", 0, 10)).toEqual({ gap: false, changes: [] });
  });

  it("returns no content for a hint missing any of its columns", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    const columns = ["sha256", "size", "mtime_ns", "inode", "ctime_ns"];
    for (const missing of columns) {
      const values = columns.map((column) =>
        column === missing ? "null" : column === "sha256" ? `'${"ab".repeat(32)}'` : "1",
      );
      await db.execute(
        sql.raw(`insert into idx.changes (root_id, path, source, ${columns.join(", ")})
          values (1, 'alice/${missing}.pdf', 'api', ${values.join(", ")})`),
      );
    }
    const page = await journal.read("files", 0, 10);
    expect(page.changes.map((change) => [change.path, change.content])).toEqual(
      columns.map((missing) => [`alice/${missing}.pdf`, null]),
    );
  });

  it("reports a gap once rows after the position were pruned, and none before", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await journal.append("files", "api", [
      { path: "alice/1.txt" },
      { path: "alice/2.txt" },
      { path: "alice/3.txt" },
    ]);
    expect((await journal.read("files", 0, 10)).gap).toBe(false);
    await age("alice/1.txt", "31 days");
    await journal.prune();
    // Position 1 was pruned: a consumer that had read it lost nothing.
    expect((await journal.read("files", 1, 10)).gap).toBe(false);
    expect((await journal.read("files", 0, 10)).gap).toBe(true);
    // The surviving rows still come back with the gap.
    expect((await journal.read("files", 0, 10)).changes.map((change) => change.path)).toEqual([
      "alice/2.txt",
      "alice/3.txt",
    ]);
  });
});

describe("positions and cursors", () => {
  it("ends at the newest position over every root, 0 when nothing was written", async () => {
    expect(await journal.end()).toBe(0);
    await db.execute(sql`insert into idx.roots (name) values ('files'), ('photos')`);
    await journal.append("files", "api", [{ path: "a" }, { path: "b" }]);
    await journal.append("photos", "api", [{ path: "c" }]);
    expect(await journal.end()).toBe(3);
  });

  it("saves and reads a position per consumer and root", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files'), ('photos')`);
    expect(await journal.cursor("indexer", "files")).toBeNull();
    await journal.saveCursor("indexer", "files", 7);
    await journal.saveCursor("indexer", "photos", 2);
    await journal.saveCursor("web", "files", 5);
    await journal.saveCursor("indexer", "files", 9);
    expect(await journal.cursor("indexer", "files")).toBe(9);
    expect(await journal.cursor("indexer", "photos")).toBe(2);
    expect(await journal.cursor("web", "files")).toBe(5);
    expect(await journal.cursor("web", "photos")).toBeNull();
    // A root the indexer has not created has no position to keep.
    await journal.saveCursor("indexer", "nowhere", 3);
    expect(await journal.cursor("indexer", "nowhere")).toBeNull();
    const updated = await db.execute<{ fresh: boolean }>(
      sql`select bool_and(updated_at > now() - interval '1 minute') as fresh from idx.change_cursors`,
    );
    expect(updated.rows[0]?.fresh).toBe(true);
  });
});
