import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  createIndexWorkWriter,
  type Db,
  INDEX_WORK_CHANNEL,
  type IndexWorkWriter,
  migrate,
} from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;
let write: IndexWorkWriter;

interface WorkRow extends Record<string, unknown> {
  root: string;
  path: string;
  target_path: string | null;
  sha256: string | null;
  size: string | null;
  mtime_ns: string | null;
  inode: string | null;
  ctime_ns: string | null;
}

async function rows(): Promise<WorkRow[]> {
  const result = await db.execute<WorkRow>(sql`
    select r.name as root, w.path, w.target_path, w.sha256, w.size::text, w.mtime_ns::text,
      w.inode::text, w.ctime_ns::text
    from idx.work w join idx.roots r on r.id = w.root_id order by w.id`);
  return result.rows;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const created = createDb(container.getConnectionUri());
  db = created.db;
  close = created.close;
  await migrate(db);
  write = createIndexWorkWriter(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

beforeEach(async () => {
  await db.execute(sql`truncate table idx.work, idx.roots restart identity cascade`);
});

describe("createIndexWorkWriter", () => {
  it("adds rows under the named root in order, with an upload's content", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('other'), ('files')`);
    await write("files", [
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
      { path: "alice/gone.txt" },
    ]);
    expect(await rows()).toEqual([
      {
        root: "files",
        path: "alice/a.pdf",
        target_path: null,
        sha256: "ab".repeat(32),
        size: "12",
        mtime_ns: "1700000000123456789",
        inode: "-5",
        ctime_ns: "1700000001000000001",
      },
      {
        root: "files",
        path: "alice/old",
        target_path: "alice/new",
        sha256: null,
        size: null,
        mtime_ns: null,
        inode: null,
        ctime_ns: null,
      },
      {
        root: "files",
        path: "alice/gone.txt",
        target_path: null,
        sha256: null,
        size: null,
        mtime_ns: null,
        inode: null,
        ctime_ns: null,
      },
    ]);
  });

  it("writes nothing for a root the indexer has not created, or for no items", async () => {
    await write("files", [{ path: "alice/a.pdf" }]);
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await write("files", []);
    expect(await rows()).toEqual([]);
  });

  it("drops rows older than a day when it writes", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await write("files", [{ path: "alice/stale.txt" }, { path: "alice/recent.txt" }]);
    await db.execute(
      sql`update idx.work set created_at = now() - interval '25 hours' where path = 'alice/stale.txt'`,
    );
    await write("files", [{ path: "alice/new.txt" }]);
    expect((await rows()).map((row) => row.path)).toEqual(["alice/recent.txt", "alice/new.txt"]);
  });

  it("wakes listeners with the root's name once the rows are committed", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    const listener = new Client({ connectionString: container.getConnectionUri() });
    await listener.connect();
    try {
      await listener.query(`listen ${INDEX_WORK_CHANNEL}`);
      const notified = new Promise<{ channel: string; payload: string | undefined }>((resolve) => {
        listener.once("notification", (message) =>
          resolve({ channel: message.channel, payload: message.payload }),
        );
      });
      await write("files", [{ path: "alice/a.txt" }]);
      expect(await notified).toEqual({ channel: "idx_work", payload: "files" });
      expect(await rows()).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });

  it("goes with its root", async () => {
    await db.execute(sql`insert into idx.roots (name) values ('files')`);
    await write("files", [{ path: "alice/a.txt" }]);
    await db.execute(sql`delete from idx.roots where name = 'files'`);
    expect(await rows()).toEqual([]);
  });
});
