import { parseHomeTemplate } from "@fdrive/core";
import type { ContentHit, FilenameHit, IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { EmbedClient } from "./embeddings.js";
import { createSearchService, type SearchServiceDeps } from "./service.js";

const HOME_TEMPLATE = parseHomeTemplate("sftpgo:/{username}");
const NOW = new Date("2026-03-01T00:00:00.000Z");

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => fail("rootIdsByName")),
    stats: overrides.stats ?? (async () => fail("stats")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
  };
}

function makeFile(overrides: Partial<IndexedFile> & { id: number }): IndexedFile {
  return {
    rootId: 1,
    path: "alice/a.txt",
    name: "a.txt",
    ext: ".txt",
    size: 100,
    mtimeNs: 1_740_787_200_000_000_000n, // 2025-03-01T00:00:00Z, arbitrary
    sha256: null,
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<SearchServiceDeps> = {}): SearchServiceDeps {
  return {
    indexQueries: fakeIndexQueries(),
    embedClient: null,
    homeTemplate: HOME_TEMPLATE,
    indexRootNames: new Set(["sftpgo"]),
    thumbsEnabled: false,
    trashPath: null,
    clock: () => NOW,
    ...overrides,
  };
}

const NO_FILTERS = { exts: null, folder: null, after: null, before: null };

function baseInput(
  overrides: Partial<Parameters<ReturnType<typeof createSearchService>["search"]>[0]> = {},
) {
  return {
    username: "alice",
    query: "readme",
    filters: NO_FILTERS,
    limit: 20,
    ...overrides,
  };
}

describe("createSearchService: status", () => {
  it("is unavailable and non-semantic with no configured roots and no embed client", () => {
    const service = createSearchService(buildDeps({ indexRootNames: new Set() }));
    expect(service.status()).toEqual({ available: false, semantic: false });
  });

  it("is available and semantic when roots and an embed client are configured", () => {
    const embedClient: EmbedClient = { embed: async () => [0.1] };
    const service = createSearchService(buildDeps({ embedClient }));
    expect(service.status()).toEqual({ available: true, semantic: true });
  });
});

describe("createSearchService: search - unavailable", () => {
  it("is unavailable when no index roots are configured, without touching the index", async () => {
    const service = createSearchService(buildDeps({ indexRootNames: new Set() }));

    const result = await service.search(baseInput());

    expect(result).toEqual({
      query: "readme",
      sections: { folders: [], files: [], content: [] },
      degraded: false,
      unavailable: true,
      tookMs: 0,
    });
  });

  it("is unavailable when the identity's home root is not a configured index root", async () => {
    const service = createSearchService(buildDeps({ indexRootNames: new Set(["other-root"]) }));

    const result = await service.search(baseInput());

    expect(result.unavailable).toBe(true);
  });

  it("is unavailable when the username is not a safe path segment", async () => {
    const service = createSearchService(buildDeps());

    const result = await service.search(baseInput({ username: "a/b" }));

    expect(result.unavailable).toBe(true);
  });

  it("is unavailable when the configured root name has no matching row in the index", async () => {
    const indexQueries = fakeIndexQueries({ rootIdsByName: async () => ({}) });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput());

    expect(result.unavailable).toBe(true);
  });
});

describe("createSearchService: search - degraded", () => {
  function depsWithNoMatches(overrides: Partial<SearchServiceDeps> = {}) {
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [],
    });
    return buildDeps({ indexQueries, ...overrides });
  }

  it("is degraded when no embed client is configured", async () => {
    const service = createSearchService(depsWithNoMatches());
    const result = await service.search(baseInput());
    expect(result.degraded).toBe(true);
  });

  it("is degraded when the embed client fails to produce a vector", async () => {
    const embedClient: EmbedClient = { embed: async () => null };
    const service = createSearchService(depsWithNoMatches({ embedClient }));
    const result = await service.search(baseInput());
    expect(result.degraded).toBe(true);
  });

  it("is not degraded when the embed client returns a vector", async () => {
    const embedClient: EmbedClient = { embed: async () => [0.1, 0.2] };
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [],
    });
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));
    const result = await service.search(baseInput());
    expect(result.degraded).toBe(false);
  });

  it("returns an available, empty result when nothing matches", async () => {
    const service = createSearchService(depsWithNoMatches());
    const result = await service.search(baseInput());
    expect(result.unavailable).toBe(false);
    expect(result.sections).toEqual({ folders: [], files: [], content: [] });
  });
});

describe("createSearchService: search - hits", () => {
  it("maps a filename-only hit to a virtual path, with an empty snippet list", async () => {
    const file = makeFile({ id: 10, path: "alice/report.pdf", name: "report.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 10, hits: 1, similarity: 0.8 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "report" }));

    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]).toMatchObject({
      path: "/report.pdf",
      name: "report.pdf",
      ext: ".pdf",
      snippets: [],
      hasThumbnail: false,
    });
    expect(result.sections.content).toEqual([]);
  });

  it("attaches snippets with highlight ranges for a content hit", async () => {
    const file = makeFile({ id: 20, path: "alice/notes.md", name: "notes.md", ext: ".md" });
    const contentHits: ContentHit[] = [{ fileId: 20, snippet: "the readme explains setup" }];
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => contentHits,
      filename: async () => [],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "readme" }));

    expect(result.sections.content).toHaveLength(1);
    const hit = result.sections.content[0];
    expect(hit?.snippets).toEqual([
      { text: "the readme explains setup", ranges: [{ start: 4, end: 10 }] },
    ]);
  });

  it("sums semantic and filename contributions for the same file", async () => {
    const file = makeFile({ id: 30, path: "alice/report.pdf", name: "report.pdf" });
    const embedClient: EmbedClient = { embed: async () => [0.1] };
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [{ fileId: 30, snippet: "report contents" }],
      fulltext: async () => [],
      filename: async () => [{ fileId: 30, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    const result = await service.search(baseInput({ query: "report" }));

    expect(result.sections.files).toHaveLength(1);
    // 1/(60+1) from semantic, plus filenameScore(1,1,1,60) from filename.
    const expectedScore = 1 / 61 + ((0.6 + 0.4 * (1 / 1)) * 1.5) / 61;
    expect(result.sections.files[0]?.score).toBeCloseTo(expectedScore, 10);
  });

  it("drops a file whose root is not in the configured roots map", async () => {
    const file = makeFile({ id: 40, rootId: 99, path: "alice/x.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 40, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput());

    expect(result.sections.files).toEqual([]);
  });

  it("drops a hit that fails the search filters", async () => {
    const file = makeFile({ id: 50, path: "alice/report.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 50, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(
      baseInput({ filters: { exts: [".docx"], folder: null, after: null, before: null } }),
    );

    expect(result.sections.files).toEqual([]);
  });

  it("respects the limit", async () => {
    const files = [makeFile({ id: 1 }), makeFile({ id: 2 }), makeFile({ id: 3 })];
    const filenameHits: FilenameHit[] = files.map((f, i) => ({
      fileId: f.id,
      hits: 1,
      similarity: 1 - i * 0.1,
    }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => filenameHits,
      filesByIds: async () => files,
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ limit: 2 }));

    expect(result.sections.files).toHaveLength(2);
  });

  it("caps the content section at 10 hits", async () => {
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile({ id: i + 1, path: `alice/f${i}.md` }),
    );
    const contentHits: ContentHit[] = files.map((f) => ({ fileId: f.id, snippet: "readme text" }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => contentHits,
      filename: async () => [],
      filesByIds: async () => files,
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ limit: 15, query: "readme" }));

    expect(result.sections.content).toHaveLength(10);
  });

  it("checks the thumbnail cache only when thumbnails are enabled and a sha256 is known", async () => {
    const file = makeFile({ id: 60, sha256: "abc123" });
    const thumbnail = vi.fn(async () => ({ storagePath: "ab/abc123.256.webp" }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 60, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnail,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));

    const result = await service.search(baseInput());

    expect(thumbnail).toHaveBeenCalledWith("abc123", 256);
    expect(result.sections.files[0]?.hasThumbnail).toBe(true);
  });

  it("never checks the thumbnail cache when thumbnails are disabled", async () => {
    const file = makeFile({ id: 61, sha256: "abc123" });
    const thumbnail = vi.fn(async () => ({ storagePath: "x" }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 61, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnail,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: false }));

    const result = await service.search(baseInput());

    expect(thumbnail).not.toHaveBeenCalled();
    expect(result.sections.files[0]?.hasThumbnail).toBe(false);
  });

  it("never checks the thumbnail cache when the file has no sha256", async () => {
    const file = makeFile({ id: 62, sha256: null });
    const thumbnail = vi.fn(async () => ({ storagePath: "x" }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 62, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnail,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));

    await service.search(baseInput());

    expect(thumbnail).not.toHaveBeenCalled();
  });

  it("derives up to five folders from the filename query's parent paths", async () => {
    const files = Array.from({ length: 7 }, (_, i) =>
      makeFile({ id: i + 1, path: `alice/folder${i}/report.pdf`, name: "report.pdf" }),
    );
    const filenameHits: FilenameHit[] = files.map((f) => ({
      fileId: f.id,
      hits: 1,
      similarity: 0.5,
    }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => filenameHits,
      filesByIds: async () => files,
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ limit: 100 }));

    expect(result.sections.folders).toHaveLength(5);
    expect(result.sections.folders[0]).toMatchObject({ kind: "dir", size: 0, ext: "", mime: null });
  });

  it("skips a folder whose file's root cannot be mapped back to a virtual path", async () => {
    const file = makeFile({ id: 70, rootId: 99 });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 70, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput());

    expect(result.sections.folders).toEqual([]);
  });

  it("excludes a file whose virtual path is inside the trash from search hits", async () => {
    const file = makeFile({ id: 71, path: "alice/.trash/removed.txt", name: "removed.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 71, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, trashPath: "/.trash" }));

    const result = await service.search(baseInput());

    expect(result.sections.files).toEqual([]);
    expect(result.sections.content).toEqual([]);
  });

  it("excludes a file whose virtual path equals the trash folder itself", async () => {
    const file = makeFile({ id: 73, path: "alice/.trash", name: ".trash" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 73, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, trashPath: "/.trash" }));

    const result = await service.search(baseInput());

    expect(result.sections.files).toEqual([]);
  });

  it("excludes the trash folder itself from derived folder groupings", async () => {
    const file = makeFile({ id: 72, path: "alice/.trash/leaf.txt", name: "leaf.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 72, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, trashPath: "/.trash" }));

    const result = await service.search(baseInput());

    expect(result.sections.folders).toEqual([]);
  });

  it("skips a filename hit whose file id is not returned by filesByIds", async () => {
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 999, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput());

    expect(result.sections.files).toEqual([]);
    expect(result.sections.folders).toEqual([]);
  });

  it("skips the fulltext and filename queries when the query has no usable tokens", async () => {
    const embedClient: EmbedClient = { embed: async () => [0.1] };
    const file = makeFile({ id: 80, path: "alice/a.txt" });
    const fulltext = vi.fn(async () => []);
    const filename = vi.fn(async () => []);
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [{ fileId: 80, snippet: "hit" }],
      fulltext,
      filename,
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    // A single-character query has no fulltext token (needs length >= 2)
    // and no filename word (needs length >= 3).
    const result = await service.search(baseInput({ query: "a" }));

    expect(fulltext).not.toHaveBeenCalled();
    expect(filename).not.toHaveBeenCalled();
    expect(result.sections.files).toHaveLength(1);
  });

  it("reports tookMs from the clock", async () => {
    let now = NOW.getTime();
    const clock = () => {
      const at = new Date(now);
      now += 25;
      return at;
    };
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [],
    });
    const service = createSearchService(buildDeps({ indexQueries, clock }));

    const result = await service.search(baseInput());

    expect(result.tookMs).toBeGreaterThan(0);
  });
});
