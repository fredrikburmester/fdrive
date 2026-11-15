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
  root_id: number;
  path: string;
  target_path: string | null;
  source: string;
  sha256: string | null;
  size: string | null;
  mtime_ns: string | null;
  inode: string | null;
  ctime_ns: string | null;
  previous_ctime_ns: string | null;
}

async function rows(): Promise<ChangeRow[]> {
  const result = await db.execute<ChangeRow>(sql`
    select c.root_id, c.path, c.target_path, c.source, c.sha256, c.size::text,
      c.mtime_ns::text, c.inode::text, c.ctime_ns::text, c.previous_ctime_ns::text
    from idx.changes c order by c.id`);
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
  await db.execute(sql`truncate table idx.changes, idx.change_cursors restart identity`);
});

describe("append", () => {
  it("adds rows under the files root in order, with their source and an upload's content", async () => {
    await journal.append("api", [
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
      {
        path: "alice/b.pdf",
        targetPath: "alice/c.pdf",
        stamp: { size: 7, mtimeNs: 5n, ino: 2n ** 64n - 6n, ctimeNs: 6n, previousCtimeNs: 4n },
      },
    ]);
    await journal.append("scan", [{ path: "alice/gone.txt" }]);
    const none = {
      sha256: null,
      size: null,
      mtime_ns: null,
      inode: null,
      ctime_ns: null,
      previous_ctime_ns: null,
    };
    expect(await rows()).toEqual([
      {
        root_id: 1,
        path: "alice/a.pdf",
        target_path: null,
        source: "api",
        sha256: "ab".repeat(32),
        size: "12",
        mtime_ns: "1700000000123456789",
        inode: "-5",
        ctime_ns: "1700000001000000001",
        previous_ctime_ns: null,
      },
      { root_id: 1, path: "alice/old", target_path: "alice/new", source: "api", ...none },
      // A moved file as the rename left it, and its change time before: no digest.
      {
        root_id: 1,
        path: "alice/b.pdf",
        target_path: "alice/c.pdf",
        source: "api",
        sha256: null,
        size: "7",
        mtime_ns: "5",
        inode: "-6",
        ctime_ns: "6",
        previous_ctime_ns: "4",
      },
      { root_id: 1, path: "alice/gone.txt", target_path: null, source: "scan", ...none },
    ]);
  });

  it("writes nothing for no items", async () => {
    await journal.append("api", []);
    expect(await rows()).toEqual([]);
  });

  it("refuses a source the journal does not know", async () => {
    await expect(
      db.execute(
        sql`insert into idx.changes (root_id, path, source) values (1, 'alice/a.txt', 'web')`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: "changes_source" } });
  });

  it("wakes listeners with the root's name once the rows are committed", async () => {
    const listener = new Client({ connectionString: container.getConnectionUri() });
    await listener.connect();
    try {
      await listener.query(`listen ${CHANGES_CHANNEL}`);
      const notified = new Promise<{ channel: string; payload: string | undefined }>((resolve) => {
        listener.once("notification", (message) =>
          resolve({ channel: message.channel, payload: message.payload }),
        );
      });
      await journal.append("api", [{ path: "alice/a.txt" }]);
      expect(await notified).toEqual({ channel: "idx_changes", payload: "files" });
      expect(await rows()).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });

  it("waits for a writer that holds the journal's lock, so positions commit in order", async () => {
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtextextended('idx.changes', 0))");
      let done = false;
      const appended = journal.append("api", [{ path: "alice/a.txt" }]).then(() => {
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
});

describe("prune", () => {
  it("drops rows older than 30 days as a prefix and keeps the newest row", async () => {
    await journal.append("api", [
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
    await journal.append("api", [{ path: "alice/4.txt" }]);
    expect(await journal.prune()).toBe(1);
    expect(await paths()).toEqual(["alice/4.txt"]);
  });

  it("drops nothing from an empty or young journal", async () => {
    expect(await journal.prune()).toBe(0);
    await journal.append("api", [{ path: "alice/a.txt" }, { path: "alice/b.txt" }]);
    expect(await journal.prune()).toBe(0);
    expect(await paths()).toEqual(["alice/a.txt", "alice/b.txt"]);
  });

  it("runs before each write of a source's writer", async () => {
    const write = createChangeWriter(db, "api");
    await write([{ path: "alice/stale.txt" }, { path: "alice/recent.txt" }]);
    await age("alice/stale.txt", "31 days");
    await write([]);
    expect(await paths()).toEqual(["alice/stale.txt", "alice/recent.txt"]);
    await write([{ path: "alice/new.txt" }]);
    expect(await paths()).toEqual(["alice/recent.txt", "alice/new.txt"]);
  });
});

describe("read", () => {
  it("returns the rows after a position, oldest first, up to a limit", async () => {
    await journal.append("api", [
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
    await journal.append("scan", [{ path: "alice/old", targetPath: "alice/new" }]);
    await journal.append("ocr", [{ path: "alice/b.pdf" }]);

    const page = await journal.read(0, 2);
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
      {
        position: 2,
        path: "alice/old",
        targetPath: "alice/new",
        source: "scan",
        content: null,
      },
    ]);
    expect(page.changes[0]?.createdAt).toBeInstanceOf(Date);
    const rest = await journal.read(2, 10);
    expect(rest.changes.map((change) => [change.position, change.source])).toEqual([[3, "ocr"]]);
    expect((await journal.read(3, 10)).changes).toEqual([]);
  });

  it("returns no content for a hint missing any of its columns", async () => {
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
    const page = await journal.read(0, 10);
    expect(page.changes.map((change) => [change.path, change.content])).toEqual(
      columns.map((missing) => [`alice/${missing}.pdf`, null]),
    );
  });

  it("reports a gap once rows after the position were pruned, and none before", async () => {
    await journal.append("api", [
      { path: "alice/1.txt" },
      { path: "alice/2.txt" },
      { path: "alice/3.txt" },
    ]);
    expect((await journal.read(0, 10)).gap).toBe(false);
    await age("alice/1.txt", "31 days");
    await journal.prune();
    // Position 1 was pruned: a consumer that had read it lost nothing.
    expect((await journal.read(1, 10)).gap).toBe(false);
    expect((await journal.read(0, 10)).gap).toBe(true);
    // The surviving rows still come back with the gap.
    expect((await journal.read(0, 10)).changes.map((change) => change.path)).toEqual([
      "alice/2.txt",
      "alice/3.txt",
    ]);
  });
});

describe("epoch", () => {
  it("names the journal with one id until the database starts again without it", async () => {
    await db.execute(sql`delete from idx.change_epoch`);
    // Readers creating it at the same moment agree on it.
    const created = await Promise.all([1, 2, 3, 4].map(() => journal.epoch()));
    const first = created[0];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(created)).toEqual(new Set([first]));
    expect(await journal.epoch()).toBe(first);
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from idx.change_epoch`,
    );
    expect(rows.rows[0]?.n).toBe(1);
    // A restored database has no row (the table is never backed up): a new epoch.
    await db.execute(sql`delete from idx.change_epoch`);
    expect(await journal.epoch()).not.toBe(first);
  });
});

describe("positions and cursors", () => {
  it("ends at the newest position, 0 when nothing was written", async () => {
    expect(await journal.end()).toBe(0);
    await journal.append("api", [{ path: "a" }, { path: "b" }]);
    await journal.append("api", [{ path: "c" }]);
    expect(await journal.end()).toBe(3);
  });

  it("saves and reads a position per consumer", async () => {
    expect(await journal.cursor("indexer")).toBeNull();
    await journal.saveCursor("indexer", 7);
    await journal.saveCursor("web", 5);
    await journal.saveCursor("indexer", 9);
    expect(await journal.cursor("indexer")).toBe(9);
    expect(await journal.cursor("web")).toBe(5);
    expect(await journal.cursor("mac")).toBeNull();
    const updated = await db.execute<{ fresh: boolean }>(
      sql`select bool_and(updated_at > now() - interval '1 minute') as fresh from idx.change_cursors`,
    );
    expect(updated.rows[0]?.fresh).toBe(true);
  });
});
