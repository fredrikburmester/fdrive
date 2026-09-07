import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  createIndexQueries,
  type Db,
  type IndexQueries,
  migrate,
  schema,
} from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;
let queries: IndexQueries;

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
  queries = createIndexQueries(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

beforeEach(async () => {
  await db.execute(
    sql`truncate table idx.roots, app.thumbnails, app.image_embeddings restart identity cascade`,
  );
});

/** 384-dim vector that ramps linearly, shifted by `offset`; two close offsets cosine-distance near 0. */
function rampVector(offset: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i + offset) / 384);
}

/** A vector pointing the opposite direction of `rampVector`, for a clearly distant embedding. */
function reverseRampVector(offset: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (383 - i + offset) / 384);
}

/** 1024-dim vector that ramps linearly, shifted by `offset`; two close offsets cosine-distance near 0. */
function rampVector1024(offset: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i + offset) / 1024);
}

/** A vector pointing the opposite direction of `rampVector1024`, for a clearly distant embedding. */
function reverseRampVector1024(offset: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (1023 - i + offset) / 1024);
}

async function insertImageEmbedding(contentKey: string, model: string, embedding: number[]) {
  await db.insert(schema.imageEmbeddings).values({ contentKey, model, embedding });
}

async function insertRoot(name: string): Promise<number> {
  const [row] = await db.insert(schema.roots).values({ name }).returning();
  if (row === undefined) {
    throw new Error("expected root to be inserted");
  }
  return row.id;
}

interface InsertFileOptions {
  readonly size?: number;
  readonly mtimeNs?: bigint;
  readonly sha256?: string | null;
  readonly textStatus?: string;
  readonly deletedAt?: Date | null;
}

async function insertFile(rootId: number, path: string, opts: InsertFileOptions = {}) {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  const ext = dotIndex > 0 ? name.slice(dotIndex) : "";
  const [row] = await db
    .insert(schema.files)
    .values({
      rootId,
      path,
      name,
      ext,
      size: opts.size ?? 100,
      mtimeNs: opts.mtimeNs ?? 1_700_000_000_000_000_000n,
      sha256: opts.sha256 ?? null,
      textStatus: opts.textStatus ?? "done",
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  if (row === undefined) {
    throw new Error("expected file to be inserted");
  }
  return row;
}

async function insertChunk(fileId: number, idx: number, text: string, embedding?: number[]) {
  await db.insert(schema.chunks).values({
    fileId,
    idx,
    text,
    ...(embedding !== undefined ? { embedding } : {}),
  });
}

describe("index-queries", () => {
  describe("semantic", () => {
    it("orders chunks by cosine distance, closest first", async () => {
      const rootId = await insertRoot("primary");
      const close = await insertFile(rootId, "alice/docs/readme.md");
      const far = await insertFile(rootId, "alice/docs/other.md");
      await insertChunk(close.id, 0, "close text", rampVector(0));
      await insertChunk(far.id, 0, "far text", reverseRampVector(0));

      const results = await queries.semantic([{ rootId, fsPrefix: "/" }], rampVector(0.001), 10);

      expect(results.map((r) => r.fileId)).toEqual([close.id, far.id]);
      expect(results[0]?.snippet).toBe("close text");
    });

    it("excludes chunks with no embedding", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/readme.md");
      await insertChunk(file.id, 0, "no embedding here");

      const results = await queries.semantic([{ rootId, fsPrefix: "/" }], rampVector(0), 10);

      expect(results).toEqual([]);
    });

    it("excludes deleted files", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/readme.md", { deletedAt: new Date() });
      await insertChunk(file.id, 0, "gone", rampVector(0));

      const results = await queries.semantic([{ rootId, fsPrefix: "/" }], rampVector(0), 10);

      expect(results).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/docs/readme.md");
      const outOfScope = await insertFile(rootId, "bob/docs/readme.md");
      await insertChunk(inScope.id, 0, "alice's text", rampVector(0));
      await insertChunk(outOfScope.id, 0, "bob's text", rampVector(0));

      const results = await queries.semantic([{ rootId, fsPrefix: "/alice" }], rampVector(0), 10);

      expect(results.map((r) => r.fileId)).toEqual([inScope.id]);
    });

    it("never returns rows from a root outside the scope prefixes", async () => {
      const scoped = await insertRoot("scoped-root");
      const other = await insertRoot("other-root");
      const inScope = await insertFile(scoped, "alice/readme.md");
      const outOfScope = await insertFile(other, "alice/readme.md");
      await insertChunk(inScope.id, 0, "in", rampVector(0));
      await insertChunk(outOfScope.id, 0, "out", rampVector(0));

      const results = await queries.semantic(
        [{ rootId: scoped, fsPrefix: "/" }],
        rampVector(0),
        10,
      );

      expect(results.map((r) => r.fileId)).toEqual([inScope.id]);
    });

    it("respects the limit", async () => {
      const rootId = await insertRoot("primary");
      const first = await insertFile(rootId, "a.md");
      const second = await insertFile(rootId, "b.md");
      await insertChunk(first.id, 0, "a", rampVector(0));
      await insertChunk(second.id, 0, "b", rampVector(1));

      const results = await queries.semantic([{ rootId, fsPrefix: "/" }], rampVector(0), 1);

      expect(results).toHaveLength(1);
    });
  });

  describe("fulltext", () => {
    it("finds a chunk matching the tsquery", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/report.md");
      await insertChunk(file.id, 0, "the quarterly report contains numbers");

      const results = await queries.fulltext([{ rootId, fsPrefix: "/" }], "quarterly:*", 10);

      expect(results).toHaveLength(1);
      expect(results[0]?.fileId).toBe(file.id);
      expect(results[0]?.snippet).toContain("quarterly");
    });

    it("returns an empty array for an empty tsquery", async () => {
      const rootId = await insertRoot("primary");
      const results = await queries.fulltext([{ rootId, fsPrefix: "/" }], "", 10);
      expect(results).toEqual([]);
    });

    it("does not match unrelated text", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/report.md");
      await insertChunk(file.id, 0, "nothing to do with the search term");

      const results = await queries.fulltext([{ rootId, fsPrefix: "/" }], "quarterly:*", 10);

      expect(results).toEqual([]);
    });

    it("excludes deleted files", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/report.md", { deletedAt: new Date() });
      await insertChunk(file.id, 0, "quarterly numbers");

      const results = await queries.fulltext([{ rootId, fsPrefix: "/" }], "quarterly:*", 10);

      expect(results).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/report.md");
      const outOfScope = await insertFile(rootId, "bob/report.md");
      await insertChunk(inScope.id, 0, "quarterly numbers for alice");
      await insertChunk(outOfScope.id, 0, "quarterly numbers for bob");

      const results = await queries.fulltext([{ rootId, fsPrefix: "/alice" }], "quarterly:*", 10);

      expect(results.map((r) => r.fileId)).toEqual([inScope.id]);
    });

    it("orders by rank, best match first", async () => {
      const rootId = await insertRoot("primary");
      const strong = await insertFile(rootId, "strong.md");
      const weak = await insertFile(rootId, "weak.md");
      await insertChunk(strong.id, 0, "quarterly quarterly quarterly report");
      await insertChunk(weak.id, 0, "a passing mention of quarterly");

      const results = await queries.fulltext([{ rootId, fsPrefix: "/" }], "quarterly:*", 10);

      expect(results[0]?.fileId).toBe(strong.id);
    });
  });

  describe("filename", () => {
    it("finds a file whose path contains a query word", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/docs/report.pdf");

      const results = await queries.filename([{ rootId, fsPrefix: "/" }], ["report"], "report", 10);

      expect(results).toHaveLength(1);
      expect(results[0]?.fileId).toBe(file.id);
      expect(results[0]?.hits).toBe(1);
    });

    it("returns an empty array when there are no words", async () => {
      const rootId = await insertRoot("primary");
      const results = await queries.filename([{ rootId, fsPrefix: "/" }], [], "x", 10);
      expect(results).toEqual([]);
    });

    it("scores more matching words with more hits", async () => {
      const rootId = await insertRoot("primary");
      const both = await insertFile(rootId, "alice/annual/report.pdf");
      const one = await insertFile(rootId, "alice/report.pdf");
      await insertFile(rootId, "alice/other.pdf");

      const results = await queries.filename(
        [{ rootId, fsPrefix: "/" }],
        ["annual", "report"],
        "annual report",
        10,
      );

      const byId = new Map(results.map((r) => [r.fileId, r.hits]));
      expect(byId.get(both.id)).toBe(2);
      expect(byId.get(one.id)).toBe(1);
    });

    it("finds a file by trigram similarity even without a substring hit", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/receit.pdf");

      const results = await queries.filename(
        [{ rootId, fsPrefix: "/" }],
        ["receipt"],
        "receipt",
        10,
      );

      expect(results.map((r) => r.fileId)).toContain(file.id);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/report.pdf");
      await insertFile(rootId, "bob/report.pdf");

      const results = await queries.filename(
        [{ rootId, fsPrefix: "/alice" }],
        ["report"],
        "report",
        10,
      );

      expect(results.map((r) => r.fileId)).toEqual([inScope.id]);
    });

    it("excludes deleted files", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/report.pdf", { deletedAt: new Date() });

      const results = await queries.filename([{ rootId, fsPrefix: "/" }], ["report"], "report", 10);

      expect(results).toEqual([]);
    });
  });

  describe("filesByIds", () => {
    it("loads files by id and skips missing ids", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/a.txt");

      const results = await queries.filesByIds([file.id, 999_999]);

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(file.id);
    });

    it("returns an empty array for an empty id list", async () => {
      expect(await queries.filesByIds([])).toEqual([]);
    });
  });

  describe("fileByPath", () => {
    it("finds the file at exactly the given path in the given root", async () => {
      const rootId = await insertRoot("primary");
      const file = await insertFile(rootId, "alice/a.txt");

      const found = await queries.fileByPath(rootId, "alice/a.txt");

      expect(found?.id).toBe(file.id);
    });

    it("returns null for a path that does not exist", async () => {
      const rootId = await insertRoot("primary");
      expect(await queries.fileByPath(rootId, "nope.txt")).toBeNull();
    });

    it("returns null for a deleted file", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/a.txt", { deletedAt: new Date() });
      expect(await queries.fileByPath(rootId, "alice/a.txt")).toBeNull();
    });

    it("does not match the same path in a different root", async () => {
      const rootId = await insertRoot("primary");
      const otherRoot = await insertRoot("other");
      await insertFile(otherRoot, "alice/a.txt");
      expect(await queries.fileByPath(rootId, "alice/a.txt")).toBeNull();
    });
  });

  describe("rootIdsByName", () => {
    it("maps every root's name to its id", async () => {
      const first = await insertRoot("sftpgo");
      const second = await insertRoot("photos");

      const map = await queries.rootIdsByName();

      expect(map).toEqual({ sftpgo: first, photos: second });
    });

    it("returns an empty object when there are no roots", async () => {
      expect(await queries.rootIdsByName()).toEqual({});
    });
  });

  describe("stats", () => {
    it("aggregates files and chunks within scope", async () => {
      const rootId = await insertRoot("primary");
      const done = await insertFile(rootId, "alice/a.txt", { textStatus: "done", size: 10 });
      const pending = await insertFile(rootId, "alice/b.txt", { textStatus: "pending", size: 5 });
      await insertChunk(done.id, 0, "text", rampVector(0));
      await insertChunk(pending.id, 0, "text");

      const stats = await queries.stats([{ rootId, fsPrefix: "/" }]);

      expect(stats.filesTracked).toBe(2);
      expect(stats.chunks).toBe(2);
      expect(stats.chunksEmbedded).toBe(1);
      const byStatus = new Map(stats.byTextStatus.map((s) => [s.status, s]));
      expect(byStatus.get("done")).toEqual({ status: "done", files: 1, bytes: 10 });
      expect(byStatus.get("pending")).toEqual({ status: "pending", files: 1, bytes: 5 });
    });

    it("excludes rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/a.txt");
      await insertFile(rootId, "bob/b.txt");

      const stats = await queries.stats([{ rootId, fsPrefix: "/alice" }]);

      expect(stats.filesTracked).toBe(1);
    });

    it("reports zero for an empty scope", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/a.txt");

      const stats = await queries.stats([]);

      expect(stats.filesTracked).toBe(0);
      expect(stats.chunks).toBe(0);
      expect(stats.chunksEmbedded).toBe(0);
      expect(stats.byTextStatus).toEqual([]);
    });
  });

  describe("statsForFileIds", () => {
    it("counts chunks only for the given file ids, ignoring other files in scope", async () => {
      const rootId = await insertRoot("primary");
      const included = await insertFile(rootId, "alice/a.txt");
      const excluded = await insertFile(rootId, "alice/b.txt");
      await insertChunk(included.id, 0, "text", rampVector(0));
      await insertChunk(included.id, 1, "text");
      await insertChunk(excluded.id, 0, "text", rampVector(0));

      const stats = await queries.statsForFileIds([included.id]);

      expect(stats.chunks).toBe(2);
      expect(stats.chunksEmbedded).toBe(1);
    });

    it("returns zero counts for an empty id list without querying", async () => {
      const stats = await queries.statsForFileIds([]);

      expect(stats).toEqual({ chunks: 0, chunksEmbedded: 0 });
    });

    it("caps the id list defensively at MAX_STATS_FILE_ID_PARAMS", async () => {
      const rootId = await insertRoot("primary");
      const inCap = await insertFile(rootId, "alice/a.txt");
      await insertChunk(inCap.id, 0, "text");
      // A huge id far outside any real range: if the cap were not applied,
      // this alone would not change the result, but this test exists to
      // document and pin the defensive slice rather than only trusting the
      // caller to have already capped its input.
      const idsWithHugeTail = [inCap.id, ...Array.from({ length: 2500 }, (_, i) => 10_000_000 + i)];

      const stats = await queries.statsForFileIds(idsWithHugeTail);

      expect(stats.chunks).toBe(1);
    });
  });

  describe("duplicates", () => {
    it("groups files sharing a sha256 and size", async () => {
      const rootId = await insertRoot("primary");
      const sha = "a".repeat(64);
      const first = await insertFile(rootId, "alice/a.txt", { sha256: sha, size: 1000 });
      const second = await insertFile(rootId, "alice/copy/a.txt", { sha256: sha, size: 1000 });
      await insertFile(rootId, "alice/unique.txt", { sha256: "b".repeat(64), size: 1000 });

      const groups = await queries.duplicates([{ rootId, fsPrefix: "/" }], 0, 10);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.sha256).toBe(sha);
      expect(groups[0]?.count).toBe(2);
      expect(groups[0]?.files.map((f) => f.path).sort()).toEqual([first.path, second.path].sort());
    });

    it("orders groups by wasted bytes descending", async () => {
      const rootId = await insertRoot("primary");
      const smallSha = "c".repeat(64);
      const largeSha = "d".repeat(64);
      await insertFile(rootId, "small-1.txt", { sha256: smallSha, size: 10 });
      await insertFile(rootId, "small-2.txt", { sha256: smallSha, size: 10 });
      await insertFile(rootId, "large-1.txt", { sha256: largeSha, size: 10_000 });
      await insertFile(rootId, "large-2.txt", { sha256: largeSha, size: 10_000 });

      const groups = await queries.duplicates([{ rootId, fsPrefix: "/" }], 0, 10);

      expect(groups.map((g) => g.sha256)).toEqual([largeSha, smallSha]);
    });

    it("ignores files below minSize", async () => {
      const rootId = await insertRoot("primary");
      const sha = "e".repeat(64);
      await insertFile(rootId, "a.txt", { sha256: sha, size: 5 });
      await insertFile(rootId, "b.txt", { sha256: sha, size: 5 });

      const groups = await queries.duplicates([{ rootId, fsPrefix: "/" }], 1000, 10);

      expect(groups).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const sha = "f".repeat(64);
      await insertFile(rootId, "alice/a.txt", { sha256: sha, size: 100 });
      await insertFile(rootId, "bob/a.txt", { sha256: sha, size: 100 });

      const groups = await queries.duplicates([{ rootId, fsPrefix: "/alice" }], 0, 10);

      expect(groups).toEqual([]);
    });
  });

  describe("similar", () => {
    it("ranks a file close to the target's average embedding above a distant one", async () => {
      const rootId = await insertRoot("primary");
      const target = await insertFile(rootId, "alice/target.md");
      const near = await insertFile(rootId, "alice/near.md");
      const far = await insertFile(rootId, "alice/far.md");
      await insertChunk(target.id, 0, "target chunk one", rampVector(0));
      await insertChunk(target.id, 1, "target chunk two", rampVector(0.2));
      await insertChunk(near.id, 0, "near", rampVector(0.1));
      await insertChunk(far.id, 0, "far", reverseRampVector(0));

      const results = await queries.similar(target.id, [{ rootId, fsPrefix: "/" }], 10);

      expect(results.map((r) => r.fileId)).toEqual([near.id, far.id]);
    });

    it("excludes the target file itself", async () => {
      const rootId = await insertRoot("primary");
      const target = await insertFile(rootId, "alice/target.md");
      await insertChunk(target.id, 0, "chunk", rampVector(0));

      const results = await queries.similar(target.id, [{ rootId, fsPrefix: "/" }], 10);

      expect(results.map((r) => r.fileId)).not.toContain(target.id);
    });

    it("returns an empty array when the target file has no embedded chunks", async () => {
      const rootId = await insertRoot("primary");
      const target = await insertFile(rootId, "alice/target.md");
      await insertChunk(target.id, 0, "no embedding");

      const results = await queries.similar(target.id, [{ rootId, fsPrefix: "/" }], 10);

      expect(results).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const target = await insertFile(rootId, "alice/target.md");
      const inScope = await insertFile(rootId, "alice/near.md");
      const outOfScope = await insertFile(rootId, "bob/near.md");
      await insertChunk(target.id, 0, "target", rampVector(0));
      await insertChunk(inScope.id, 0, "in", rampVector(0.1));
      await insertChunk(outOfScope.id, 0, "out", rampVector(0.1));

      const results = await queries.similar(target.id, [{ rootId, fsPrefix: "/alice" }], 10);

      expect(results.map((r) => r.fileId)).toEqual([inScope.id]);
    });
  });

  describe("recentFiles", () => {
    it("orders files by modification time, most recent first", async () => {
      const rootId = await insertRoot("primary");
      const older = await insertFile(rootId, "alice/old.txt", { mtimeNs: 1n });
      const newer = await insertFile(rootId, "alice/new.txt", { mtimeNs: 2n });

      const results = await queries.recentFiles([{ rootId, fsPrefix: "/" }], 10);

      expect(results.map((r) => r.id)).toEqual([newer.id, older.id]);
    });

    it("respects the limit", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "a.txt", { mtimeNs: 1n });
      await insertFile(rootId, "b.txt", { mtimeNs: 2n });

      const results = await queries.recentFiles([{ rootId, fsPrefix: "/" }], 1);

      expect(results).toHaveLength(1);
    });

    it("excludes deleted files", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/gone.txt", { deletedAt: new Date() });

      const results = await queries.recentFiles([{ rootId, fsPrefix: "/" }], 10);

      expect(results).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/a.txt");
      await insertFile(rootId, "bob/b.txt");

      const results = await queries.recentFiles([{ rootId, fsPrefix: "/alice" }], 10);

      expect(results.map((r) => r.id)).toEqual([inScope.id]);
    });
  });

  describe("listFiles", () => {
    it("filters by name substring", async () => {
      const rootId = await insertRoot("primary");
      const match = await insertFile(rootId, "alice/report.pdf");
      await insertFile(rootId, "alice/other.pdf");

      const { total, files } = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        { nameContains: "report" },
        "path",
        10,
      );

      expect(total).toBe(1);
      expect(files.map((f) => f.id)).toEqual([match.id]);
    });

    it("filters by extension", async () => {
      const rootId = await insertRoot("primary");
      const pdf = await insertFile(rootId, "a.pdf");
      await insertFile(rootId, "b.txt");

      const { files } = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        { ext: ".pdf" },
        "path",
        10,
      );

      expect(files.map((f) => f.id)).toEqual([pdf.id]);
    });

    it("filters by modified date range", async () => {
      const rootId = await insertRoot("primary");
      const old = await insertFile(rootId, "old.txt", { mtimeNs: 100n });
      const mid = await insertFile(rootId, "mid.txt", { mtimeNs: 200n });
      await insertFile(rootId, "new.txt", { mtimeNs: 300n });

      const { files } = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        { modifiedAfterNs: 100n, modifiedBeforeNs: 200n },
        "path",
        10,
      );

      expect(files.map((f) => f.id).sort()).toEqual([old.id, mid.id].sort());
    });

    it("filters by minimum size", async () => {
      const rootId = await insertRoot("primary");
      const big = await insertFile(rootId, "big.bin", { size: 10_000 });
      await insertFile(rootId, "small.bin", { size: 10 });

      const { files } = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        { minSize: 1000 },
        "path",
        10,
      );

      expect(files.map((f) => f.id)).toEqual([big.id]);
    });

    it("orders by modified_desc, modified_asc, size_desc, and path", async () => {
      const rootId = await insertRoot("primary");
      const a = await insertFile(rootId, "a.txt", { mtimeNs: 1n, size: 10 });
      const b = await insertFile(rootId, "b.txt", { mtimeNs: 2n, size: 20 });

      const modifiedDesc = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        {},
        "modified_desc",
        10,
      );
      expect(modifiedDesc.files.map((f) => f.id)).toEqual([b.id, a.id]);

      const modifiedAsc = await queries.listFiles(
        [{ rootId, fsPrefix: "/" }],
        {},
        "modified_asc",
        10,
      );
      expect(modifiedAsc.files.map((f) => f.id)).toEqual([a.id, b.id]);

      const sizeDesc = await queries.listFiles([{ rootId, fsPrefix: "/" }], {}, "size_desc", 10);
      expect(sizeDesc.files.map((f) => f.id)).toEqual([b.id, a.id]);

      const path = await queries.listFiles([{ rootId, fsPrefix: "/" }], {}, "path", 10);
      expect(path.files.map((f) => f.id)).toEqual([a.id, b.id]);
    });

    it("reports the total match count independent of the limit", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "a.txt");
      await insertFile(rootId, "b.txt");

      const { total, files } = await queries.listFiles([{ rootId, fsPrefix: "/" }], {}, "path", 1);

      expect(total).toBe(2);
      expect(files).toHaveLength(1);
    });

    it("excludes deleted files and rows outside the scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/a.txt");
      await insertFile(rootId, "bob/b.txt");
      await insertFile(rootId, "alice/gone.txt", { deletedAt: new Date() });

      const { total, files } = await queries.listFiles(
        [{ rootId, fsPrefix: "/alice" }],
        {},
        "path",
        10,
      );

      expect(total).toBe(1);
      expect(files.map((f) => f.id)).toEqual([inScope.id]);
    });
  });

  describe("filesBySha256", () => {
    it("finds every other file with the same hash", async () => {
      const rootId = await insertRoot("primary");
      const sha = "a".repeat(64);
      const target = await insertFile(rootId, "a.txt", { sha256: sha });
      const copy = await insertFile(rootId, "copy/a.txt", { sha256: sha });
      await insertFile(rootId, "other.txt", { sha256: "b".repeat(64) });

      const results = await queries.filesBySha256([{ rootId, fsPrefix: "/" }], sha, target.id);

      expect(results.map((f) => f.id)).toEqual([copy.id]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const sha = "c".repeat(64);
      const target = await insertFile(rootId, "alice/a.txt", { sha256: sha });
      await insertFile(rootId, "bob/a.txt", { sha256: sha });

      const results = await queries.filesBySha256([{ rootId, fsPrefix: "/alice" }], sha, target.id);

      expect(results).toEqual([]);
    });
  });

  describe("recordMove and recentMoves", () => {
    it("records a move and reads it back for the matching actor and root", async () => {
      const rootId = await insertRoot("primary");
      await queries.recordMove({ rootId, src: "a.txt", dst: "b.txt", actor: "mcp" });

      const results = await queries.recentMoves([{ rootId, fsPrefix: "/" }], "mcp", 10);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ rootId, src: "a.txt", dst: "b.txt", actor: "mcp" });
    });

    it("excludes moves from a different actor", async () => {
      const rootId = await insertRoot("primary");
      await queries.recordMove({ rootId, src: "a.txt", dst: "b.txt", actor: "user" });

      const results = await queries.recentMoves([{ rootId, fsPrefix: "/" }], "mcp", 10);

      expect(results).toEqual([]);
    });

    it("excludes moves from a root outside the scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const other = await insertRoot("other");
      await queries.recordMove({ rootId: other, src: "a.txt", dst: "b.txt", actor: "mcp" });

      const results = await queries.recentMoves([{ rootId, fsPrefix: "/" }], "mcp", 10);

      expect(results).toEqual([]);
    });

    it("returns an empty array for an empty scope", async () => {
      const rootId = await insertRoot("primary");
      await queries.recordMove({ rootId, src: "a.txt", dst: "b.txt", actor: "mcp" });

      expect(await queries.recentMoves([], "mcp", 10)).toEqual([]);
    });

    it("orders moves newest first and respects the limit", async () => {
      const rootId = await insertRoot("primary");
      await queries.recordMove({ rootId, src: "1.txt", dst: "1b.txt", actor: "mcp" });
      await queries.recordMove({ rootId, src: "2.txt", dst: "2b.txt", actor: "mcp" });

      const results = await queries.recentMoves([{ rootId, fsPrefix: "/" }], "mcp", 1);

      expect(results).toHaveLength(1);
      expect(results[0]?.src).toBe("2.txt");
    });
  });

  describe("thumbnail", () => {
    it("finds a generated thumbnail by content key and size", async () => {
      await db
        .insert(schema.thumbnails)
        .values({ contentKey: "sha-abc", size: 256, storagePath: "ab/sha-abc.256.webp" });

      const found = await queries.thumbnail("sha-abc", 256);

      expect(found).toEqual({ storagePath: "ab/sha-abc.256.webp" });
    });

    it("returns null when no thumbnail has been generated for that size", async () => {
      await db
        .insert(schema.thumbnails)
        .values({ contentKey: "sha-abc", size: 256, storagePath: "ab/sha-abc.256.webp" });

      expect(await queries.thumbnail("sha-abc", 1024)).toBeNull();
    });

    it("returns null for an unknown content key", async () => {
      expect(await queries.thumbnail("unknown", 256)).toBeNull();
    });
  });

  describe("searchImages", () => {
    const model = "google/siglip2-large-patch16-256";

    it("orders files by cosine distance, closest first", async () => {
      const rootId = await insertRoot("primary");
      const close = await insertFile(rootId, "alice/photos/close.jpg", { sha256: "sha-close" });
      const far = await insertFile(rootId, "alice/photos/far.jpg", { sha256: "sha-far" });
      await insertImageEmbedding("sha-close", model, rampVector1024(0));
      await insertImageEmbedding("sha-far", model, reverseRampVector1024(0));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/" }],
        rampVector1024(0.001),
        model,
        10,
      );

      expect(results.map((r) => r.path)).toEqual([close.path, far.path]);
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Number.POSITIVE_INFINITY);
      expect(results[0]?.rootId).toBe(rootId);
      expect(results[0]?.size).toBe(close.size);
      expect(results[0]?.modifiedAt).toBeInstanceOf(Date);
    });

    it("finds every live file sharing a content key, since content is embedded once", async () => {
      const rootId = await insertRoot("primary");
      const original = await insertFile(rootId, "alice/photos/original.jpg", { sha256: "sha-dup" });
      const copy = await insertFile(rootId, "alice/photos/copy.jpg", { sha256: "sha-dup" });
      await insertImageEmbedding("sha-dup", model, rampVector1024(0));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/" }],
        rampVector1024(0),
        model,
        10,
      );

      expect(results.map((r) => r.path).sort()).toEqual([original.path, copy.path].sort());
    });

    it("excludes rows written by a different model", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/photos/stale.jpg", { sha256: "sha-stale" });
      await insertImageEmbedding("sha-stale", "other-model", rampVector1024(0));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/" }],
        rampVector1024(0),
        model,
        10,
      );

      expect(results).toEqual([]);
    });

    it("excludes deleted files", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/photos/gone.jpg", {
        sha256: "sha-gone",
        deletedAt: new Date(),
      });
      await insertImageEmbedding("sha-gone", model, rampVector1024(0));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/" }],
        rampVector1024(0),
        model,
        10,
      );

      expect(results).toEqual([]);
    });

    it("never returns rows outside the given scope prefixes", async () => {
      const rootId = await insertRoot("primary");
      const inScope = await insertFile(rootId, "alice/photos/a.jpg", { sha256: "sha-alice" });
      await insertFile(rootId, "bob/photos/a.jpg", { sha256: "sha-bob" });
      await insertImageEmbedding("sha-alice", model, rampVector1024(0));
      await insertImageEmbedding("sha-bob", model, rampVector1024(0));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/alice" }],
        rampVector1024(0),
        model,
        10,
      );

      expect(results.map((r) => r.path)).toEqual([inScope.path]);
    });

    it("matches nothing for an empty scope", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "alice/photos/a.jpg", { sha256: "sha-a" });
      await insertImageEmbedding("sha-a", model, rampVector1024(0));

      const results = await queries.searchImages([], rampVector1024(0), model, 10);

      expect(results).toEqual([]);
    });

    it("respects the limit", async () => {
      const rootId = await insertRoot("primary");
      await insertFile(rootId, "a.jpg", { sha256: "sha-a" });
      await insertFile(rootId, "b.jpg", { sha256: "sha-b" });
      await insertImageEmbedding("sha-a", model, rampVector1024(0));
      await insertImageEmbedding("sha-b", model, rampVector1024(1));

      const results = await queries.searchImages(
        [{ rootId, fsPrefix: "/" }],
        rampVector1024(0),
        model,
        1,
      );

      expect(results).toHaveLength(1);
    });
  });

  describe("imageEmbeddingStats", () => {
    it("reports zero and a null model when the table is empty", async () => {
      expect(await queries.imageEmbeddingStats()).toEqual({ total: 0, model: null });
    });

    it("counts every row across models and reports the model with the most rows", async () => {
      await insertImageEmbedding("sha-1", "model-a", rampVector1024(0));
      await insertImageEmbedding("sha-2", "model-a", rampVector1024(1));
      await insertImageEmbedding("sha-3", "model-b", rampVector1024(2));

      const stats = await queries.imageEmbeddingStats();

      expect(stats.total).toBe(3);
      expect(stats.model).toBe("model-a");
    });
  });
});
