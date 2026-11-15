import { NAME_MATCH_BOOST, recencyWeight, type Scope } from "@fdrive/core";
import type { ContentHit, FilenameHit, FolderHit, IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { EmbedClient } from "./embeddings.js";
import type { NameIndexClient, NameIndexHit, NameIndexHits } from "./name-index.js";
import { createSearchService, type SearchServiceDeps, type SearchServiceInput } from "./service.js";

const HOME_SCOPES: readonly Scope[] = [{ fsPrefix: "/alice", virtualPrefix: "/" }];
const NOW = new Date("2026-03-01T00:00:00.000Z");

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    folders: overrides.folders ?? (async () => []),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    contentAt: overrides.contentAt ?? (async () => fail("contentAt")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    fileTextPrefix: overrides.fileTextPrefix ?? (async () => fail("fileTextPrefix")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    thumbnailKeys: overrides.thumbnailKeys ?? (async () => fail("thumbnailKeys")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    photos: overrides.photos ?? (async () => fail("photos")),
    photoDetails: overrides.photoDetails ?? (async () => fail("photoDetails")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
    bytesByExtension: overrides.bytesByExtension ?? (async () => fail("bytesByExtension")),
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

const DAY_NS = 86_400_000_000_000n;
const NOW_NS = BigInt(NOW.getTime()) * 1_000_000n;

function makeFolder(path: string, ageDays = 0, rootId = 1): FolderHit {
  return {
    rootId,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    mtimeNs: NOW_NS - BigInt(ageDays) * DAY_NS,
  };
}

/** Index queries where nothing but `folders` finds anything. */
function folderOnlyQueries(rows: readonly FolderHit[], overrides: Partial<IndexQueries> = {}) {
  return fakeIndexQueries({
    semantic: async () => [],
    fulltext: async () => [],
    filename: async () => [],
    folders: async () => [...rows],
    ...overrides,
  });
}

function buildDeps(overrides: Partial<SearchServiceDeps> = {}): SearchServiceDeps {
  return {
    indexQueries: fakeIndexQueries(),
    embedClient: null,
    thumbsEnabled: false,
    clock: () => NOW,
    ...overrides,
  };
}

const NO_FILTERS = { exts: null, folder: null, after: null, before: null };

/** fdrive's own folders in alice's home and her own Shared with me, as every query leaves them out. */
function reserved() {
  return {
    prefixes: [
      { rootId: 1, fsPrefix: "/alice/.trash" },
      { rootId: 1, fsPrefix: "/alice/.fdrive-desktop" },
      { rootId: 1, fsPrefix: "/alice/Shared with me" },
    ],
    names: [".fdrive-move-v1"],
  };
}

it("stops text search immediately when its runtime feature is disabled", async () => {
  const service = createSearchService(
    buildDeps({
      features: async () => ({ textSearch: false, semanticSearch: false, thumbnails: false }),
    }),
  );
  expect(await service.search(baseInput())).toMatchObject({
    unavailable: true,
    sections: { files: [], folders: [], content: [] },
  });
});

function baseInput(overrides: Partial<SearchServiceInput> = {}): SearchServiceInput {
  return {
    scopes: HOME_SCOPES,
    query: "readme",
    filters: NO_FILTERS,
    limit: 20,
    ...overrides,
  };
}

describe("createSearchService: search - unavailable", () => {
  it("is unavailable when no scopes are supplied, without touching the index", async () => {
    const service = createSearchService(buildDeps());

    const result = await service.search(baseInput({ scopes: [] }));

    expect(result).toEqual({
      query: "readme",
      sections: { folders: [], files: [], content: [] },
      degraded: false,
      unavailable: true,
      tookMs: 0,
    });
  });
});

describe("createSearchService: search - degraded", () => {
  function depsWithNoMatches(overrides: Partial<SearchServiceDeps> = {}) {
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [],
    });
    return buildDeps({ indexQueries, ...overrides });
  }

  it("does not warn or call embeddings when semantic search is intentionally off", async () => {
    const embed = vi.fn(async () => null);
    const service = createSearchService(
      depsWithNoMatches({
        embedClient: { embed },
        features: async () => ({ textSearch: true, semanticSearch: false, thumbnails: false }),
      }),
    );
    expect((await service.search(baseInput())).degraded).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });

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

  it("reports partial when the underlying fanout was cut, even with no matches to show", async () => {
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => Array.from({ length: 60 }, (_, i) => ({ fileId: i, snippet: "x" })),
      filename: async () => [],
      filesByIds: async () => [],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput());
    expect(result.partial).toBe(true);
  });
});

describe("createSearchService: search - query concurrency", () => {
  it("starts keyword queries with embedding and starts semantic search as soon as embedding resolves", async () => {
    let releaseEmbedding = (_value: number[] | null): void => fail("releaseEmbedding");
    const embeddingBlocked = new Promise<number[] | null>((resolve) => {
      releaseEmbedding = resolve;
    });
    let releaseKeywords = (): void => fail("releaseKeywords");
    const keywordsBlocked = new Promise<void>((resolve) => {
      releaseKeywords = resolve;
    });
    const embedClient: EmbedClient = { embed: async () => embeddingBlocked };
    const fulltext = vi.fn(async () => {
      await keywordsBlocked;
      return [];
    });
    const filename = vi.fn(async () => {
      await keywordsBlocked;
      return [];
    });
    const semantic = vi.fn(async () => []);
    const indexQueries = fakeIndexQueries({
      semantic,
      fulltext,
      filename,
    });
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    const pending = service.search(baseInput());
    await vi.waitFor(() => {
      expect(fulltext).toHaveBeenCalledOnce();
      expect(filename).toHaveBeenCalledOnce();
    });
    expect(semantic).not.toHaveBeenCalled();

    releaseEmbedding([0.1]);
    await vi.waitFor(() => expect(semantic).toHaveBeenCalledOnce());
    releaseKeywords();
    await pending;
  });
});

/** `mtimeNs` for a file modified `days` before `NOW`. */
function daysAgoNs(days: number): bigint {
  return BigInt(NOW.getTime() - days * 86_400_000) * 1_000_000n;
}

describe("createSearchService: search - ranking", () => {
  it("puts a file named after the query above one both content signals found", async () => {
    // Stored the way macOS writes it: "a" plus a combining mark, not "ä".
    const storedName = "Plan mikrolärande.md".normalize("NFD");
    const named = makeFile({
      id: 1,
      path: `alice/work/${storedName}`,
      name: storedName,
      ext: ".md",
      mtimeNs: daysAgoNs(0),
    });
    const lab = makeFile({
      id: 2,
      path: "alice/uni/Lab-3-project-planning.pdf",
      name: "Lab-3-project-planning.pdf",
      ext: ".pdf",
      mtimeNs: daysAgoNs(0),
    });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [{ fileId: 2, snippet: "create a project plan" }],
      fulltext: async () => [{ fileId: 2, snippet: "create a project plan" }],
      filename: async () => [
        { fileId: 2, hits: 1, similarity: 0.3 },
        { fileId: 1, hits: 1, similarity: 0.2 },
      ],
      filesByIds: async () => [named, lab],
    });
    const embedClient: EmbedClient = { embed: async () => [0.1] };
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    const result = await service.search(baseInput({ query: "Plan mikrolärande" }));

    expect(result.sections.files.map((hit) => hit.name)).toEqual([
      storedName,
      "Lab-3-project-planning.pdf",
    ]);
  });

  it("puts the recently modified file first when two match alike", async () => {
    const old = makeFile({ id: 1, path: "alice/a/budget.xlsx", name: "budget.xlsx", ext: ".xlsx" });
    const recent = makeFile({
      id: 2,
      path: "alice/b/budget.xlsx",
      name: "budget.xlsx",
      ext: ".xlsx",
      mtimeNs: daysAgoNs(3),
    });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [
        { fileId: 1, hits: 1, similarity: 1 },
        { fileId: 2, hits: 1, similarity: 1 },
      ],
      filesByIds: async () => [old, recent],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "budget" }));

    expect(result.sections.files.map((hit) => hit.path)).toEqual([
      "/b/budget.xlsx",
      "/a/budget.xlsx",
    ]);
  });

  it("lets a recent content match overtake an old one that ranked higher", async () => {
    const old = makeFile({ id: 1, path: "alice/old.md", name: "old.md", mtimeNs: daysAgoNs(2000) });
    const recent = makeFile({ id: 2, path: "alice/new.md", name: "new.md", mtimeNs: daysAgoNs(1) });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [
        { fileId: 1, snippet: "the budget for 2020" },
        { fileId: 2, snippet: "the budget for this year" },
      ],
      filename: async () => [],
      filesByIds: async () => [old, recent],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "budget" }));

    expect(result.sections.files.map((hit) => hit.name)).toEqual(["new.md", "old.md"]);
  });

  it("keeps an old file named after the query above a recent content match", async () => {
    const named = makeFile({
      id: 1,
      path: "alice/budget.xlsx",
      name: "budget.xlsx",
      ext: ".xlsx",
      mtimeNs: daysAgoNs(4000),
    });
    const mention = makeFile({
      id: 2,
      path: "alice/notes.md",
      name: "notes.md",
      ext: ".md",
      mtimeNs: daysAgoNs(0),
    });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [{ fileId: 2, snippet: "see the budget" }],
      filename: async () => [{ fileId: 1, hits: 1, similarity: 1 }],
      filesByIds: async () => [named, mention],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "budget" }));

    expect(result.sections.files.map((hit) => hit.name)).toEqual(["budget.xlsx", "notes.md"]);
  });

  it("still lists content matches when name matches fill the limit", async () => {
    const named = [1, 2].map((id) =>
      makeFile({ id, path: `alice/${id}/budget.xlsx`, name: "budget.xlsx", ext: ".xlsx" }),
    );
    const mention = makeFile({ id: 3, path: "alice/notes.md", name: "notes.md", ext: ".md" });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [{ fileId: 3, snippet: "see the budget" }],
      filename: async () => named.map((file) => ({ fileId: file.id, hits: 1, similarity: 1 })),
      filesByIds: async () => [...named, mention],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ query: "budget", limit: 2 }));

    expect(result.sections.files.map((hit) => hit.name)).toEqual(["budget.xlsx", "budget.xlsx"]);
    expect(result.sections.content.map((hit) => hit.name)).toEqual(["notes.md"]);
  });

  it("asks the keyword queries to weight by age and to prefer chunks holding every word", async () => {
    const fulltext = vi.fn<IndexQueries["fulltext"]>(async () => []);
    const filename = vi.fn<IndexQueries["filename"]>(async () => []);
    const indexQueries = fakeIndexQueries({
      fulltext,
      filename,
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    await service.search(baseInput({ query: "annual report" }));

    const recency = { now: NOW, halfLifeDays: 180, floor: 0.4 };
    expect(fulltext.mock.calls[0]?.[3]).toEqual({
      recency,
      preferTsquery: "annual:*&report:*",
      exclude: reserved(),
    });
    expect(filename.mock.calls[0]?.[4]).toEqual({ recency, exclude: reserved() });
  });
});

describe("createSearchService: search - hits", () => {
  it("maps a filename-only hit to a virtual path, with an empty snippet list", async () => {
    const file = makeFile({ id: 10, path: "alice/report.pdf", name: "report.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
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
      semantic: async () => [{ fileId: 30, snippet: "report contents" }],
      fulltext: async () => [],
      filename: async () => [{ fileId: 30, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    const result = await service.search(baseInput({ query: "report" }));

    expect(result.sections.files).toHaveLength(1);
    // 1/(60+1) from semantic, plus filenameScore(1,1,1,60) from filename,
    // lifted because the name is the query and weighted by the file's age.
    const fused = 1 / 61 + ((0.6 + 0.4 * (1 / 1)) * 1.5) / 61;
    const expectedScore =
      (NAME_MATCH_BOOST.exact + fused) * recencyWeight(new Date("2025-03-01T00:00:00.000Z"), NOW);
    expect(result.sections.files[0]?.score).toBeCloseTo(expectedScore, 10);
  });

  it("drops a file outside the caller's scopes", async () => {
    const file = makeFile({ id: 40, path: "bob/x.txt" });
    const indexQueries = fakeIndexQueries({
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

  it("drops a candidate a shadowing override hides, even though its physical location still exists", async () => {
    // "/shared" shadows "alice"'s physical "/alice/shared" subtree; a row
    // still filed under "alice/shared/x.txt" must never surface through
    // the home scope once the more specific override exists.
    const scopes: readonly Scope[] = [
      { fsPrefix: "/alice", virtualPrefix: "/" },
      { fsPrefix: "/team", virtualPrefix: "/shared" },
    ];
    const file = makeFile({ id: 53, path: "alice/shared/x.txt", name: "x.txt" });
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 53, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ scopes }));

    expect(result.sections.files).toEqual([]);
  });

  it("respects the limit, applied after candidates out of scope are removed", async () => {
    const files = [makeFile({ id: 1 }), makeFile({ id: 2 }), makeFile({ id: 3 })];
    const filenameHits: FilenameHit[] = files.map((f, i) => ({
      fileId: f.id,
      hits: 1,
      similarity: 1 - i * 0.1,
    }));
    const indexQueries = fakeIndexQueries({
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
    const thumbnailKeys = vi.fn(async () => new Set(["abc123"]));
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 60, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnailKeys,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));

    const result = await service.search(baseInput());

    expect(thumbnailKeys).toHaveBeenCalledWith(["abc123"], 256);
    expect(result.sections.files[0]?.hasThumbnail).toBe(true);
  });

  it("cuts to the limit, then looks thumbnails up once for what it shows", async () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      makeFile({
        id: i + 1,
        path: `alice/readme ${i}.txt`,
        name: `readme ${i}.txt`,
        sha256: `k${i}`,
      }),
    );
    const filesByIds = vi.fn(async () => files);
    const thumbnailKeys = vi.fn(async () => new Set(["k0", "k2"]));
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () =>
        files.map((f, i) => ({ fileId: f.id, hits: 1, similarity: 1 - i / 100 })),
      filesByIds,
      thumbnailKeys,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));

    const result = await service.search(baseInput({ limit: 3 }));

    expect(result.sections.files.map((hit) => [hit.name, hit.hasThumbnail])).toEqual([
      ["readme 0.txt", true],
      ["readme 1.txt", false],
      ["readme 2.txt", true],
    ]);
    expect(filesByIds).toHaveBeenCalledOnce();
    expect(thumbnailKeys).toHaveBeenCalledExactlyOnceWith(["k0", "k1", "k2"], 256);
  });

  it("returns a full page from every candidate in scope, with no live read", async () => {
    const shown = Array.from({ length: 25 }, (_, i) =>
      makeFile({ id: i + 1, path: `alice/readme ${i}.txt`, name: `readme ${i}.txt` }),
    );
    // A row in another user's home is out of scope however it ranks.
    const elsewhere = makeFile({ id: 99, path: "bob/readme.txt", name: "readme.txt" });
    const files = [elsewhere, ...shown];
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () =>
        files.map((f, i) => ({ fileId: f.id, hits: 1, similarity: 1 - i / 100 })),
      filesByIds: async () => files,
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ limit: 20 }));

    expect(result.sections.files).toHaveLength(20);
    expect(result.sections.files.map((hit) => hit.path)).not.toContain("/readme.txt");
  });

  it("never checks the thumbnail cache when thumbnails are disabled", async () => {
    const file = makeFile({ id: 61, sha256: "abc123" });
    const thumbnailKeys = vi.fn(async () => new Set(["abc123"]));
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 61, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnailKeys,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: false }));

    const result = await service.search(baseInput());

    expect(thumbnailKeys).not.toHaveBeenCalled();
    expect(result.sections.files[0]?.hasThumbnail).toBe(false);
  });

  it("never checks the thumbnail cache when the file has no sha256", async () => {
    const file = makeFile({ id: 62, sha256: null });
    const thumbnailKeys = vi.fn(async () => new Set<string>());
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 62, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnailKeys,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));

    await service.search(baseInput());

    expect(thumbnailKeys).not.toHaveBeenCalled();
  });

  it("finds a folder by its own name, empty or not, when no file matches", async () => {
    const folders = vi.fn(async () => [makeFolder("alice/Microlärande", 2)]);
    const service = createSearchService(
      buildDeps({ indexQueries: folderOnlyQueries([], { folders }) }),
    );

    const result = await service.search(baseInput({ query: "Microlä" }));

    expect(result.sections).toEqual({
      folders: [
        {
          name: "Microlärande",
          path: "/Microlärande",
          kind: "dir",
          size: 0,
          modifiedAt: "2026-02-27T00:00:00.000Z",
          ext: "",
          mime: null,
        },
      ],
      files: [],
      content: [],
    });
    expect(result.partial).toBeUndefined();
    expect(folders).toHaveBeenCalledWith(
      [{ rootId: 1, fsPrefix: "/alice" }],
      ["microlä"],
      "Microlä",
      50,
      { recency: { now: NOW, halfLifeDays: 180, floor: 0.4 }, exclude: reserved() },
    );
  });

  it("ranks folders by how their name matches, then by age", async () => {
    const rows = [
      makeFolder("alice/a/Old plan", 400),
      makeFolder("alice/b/Airplanes", 0),
      makeFolder("alice/c/Plan", 30),
      makeFolder("alice/d/New plan", 0),
      makeFolder("alice/e/plan", 30),
    ];
    const service = createSearchService(buildDeps({ indexQueries: folderOnlyQueries(rows) }));

    const result = await service.search(baseInput({ query: "plan" }));

    // Equal matches and ages fall back to the path, so the order never flickers.
    expect(result.sections.folders.map((folder) => folder.path)).toEqual([
      "/c/Plan",
      "/e/plan",
      "/d/New plan",
      "/a/Old plan",
      "/b/Airplanes",
    ]);
  });

  it("shows at most five folders", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => makeFolder(`alice/plan ${i}`, i));
    const service = createSearchService(buildDeps({ indexQueries: folderOnlyQueries(rows) }));

    const result = await service.search(baseInput({ query: "plan" }));

    expect(result.sections.folders.map((folder) => folder.name)).toEqual([
      "plan 0",
      "plan 1",
      "plan 2",
      "plan 3",
      "plan 4",
    ]);
    expect(result.partial).toBeUndefined();
  });

  it("leaves out the caller's home, other users' folders and the folder a folder filter starts in", async () => {
    const rows = [
      makeFolder("alice"),
      makeFolder("bob/plan"),
      makeFolder("alice/plan"),
      makeFolder("alice/plan/plan b"),
      makeFolder("alice/other/plan c"),
      makeFolder("alice/plan", 0, 99),
    ];
    const service = createSearchService(buildDeps({ indexQueries: folderOnlyQueries(rows) }));

    const all = await service.search(baseInput({ query: "plan" }));
    const within = await service.search(
      baseInput({ query: "plan", filters: { ...NO_FILTERS, folder: "/plan" } }),
    );

    expect(all.sections.folders.map((folder) => folder.path)).toEqual([
      "/plan",
      "/other/plan c",
      "/plan/plan b",
    ]);
    expect(within.sections.folders.map((folder) => folder.path)).toEqual(["/plan/plan b"]);
  });

  it("applies the date filters to a folder's modification time", async () => {
    const rows = [makeFolder("alice/plan new", 1), makeFolder("alice/plan old", 100)];
    const service = createSearchService(buildDeps({ indexQueries: folderOnlyQueries(rows) }));

    const result = await service.search(
      baseInput({
        query: "plan",
        filters: { ...NO_FILTERS, after: new Date("2026-02-01T00:00:00.000Z") },
      }),
    );

    expect(result.sections.folders.map((folder) => folder.name)).toEqual(["plan new"]);
  });

  it("does not query folders while a type filter is active", async () => {
    const file = makeFile({ id: 80, path: "alice/report/x.pdf", name: "report.pdf", ext: ".pdf" });
    const folders = vi.fn(async () => [makeFolder("alice/report")]);
    const indexQueries = folderOnlyQueries([], {
      folders,
      filename: async () => [{ fileId: 80, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(
      baseInput({ query: "report", filters: { ...NO_FILTERS, exts: [".pdf"] } }),
    );

    expect(folders).not.toHaveBeenCalled();
    expect(result.sections.folders).toEqual([]);
    // The type filter is files-only: the Files section still lists the match.
    expect(result.sections.files).toHaveLength(1);
  });

  it("marks the response partial when the folder fanout was cut", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeFolder(`alice/readme ${i}`));
    const service = createSearchService(buildDeps({ indexQueries: folderOnlyQueries(rows) }));

    const result = await service.search(baseInput());

    expect(result.sections.folders).toHaveLength(5);
    expect(result.partial).toBe(true);
  });

  it("no longer lists the folder a matching file is in", async () => {
    const file = makeFile({ id: 63, path: "alice/microtest/readme.txt", name: "readme.txt" });
    const indexQueries = folderOnlyQueries([], {
      filename: async () => [{ fileId: 63, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput());

    expect(result.sections.folders).toEqual([]);
    expect(result.sections.files.map((hit) => hit.path)).toEqual(["/microtest/readme.txt"]);
  });

  it("asks every query to leave out fdrive's own folders, mapped through the scopes, before its limit", async () => {
    const semantic = vi.fn(async () => []);
    const fulltext = vi.fn(async () => []);
    const filename = vi.fn(async () => []);
    const folders = vi.fn(async () => []);
    const indexQueries = fakeIndexQueries({
      semantic,
      fulltext,
      filename,
      folders,
    });
    const embedClient: EmbedClient = { embed: async () => [0.1] };
    const service = createSearchService(buildDeps({ indexQueries, embedClient }));

    await service.search(baseInput());

    const exclude = reserved();
    expect(semantic).toHaveBeenCalledWith(expect.anything(), [0.1], 60, { exclude });
    expect(fulltext).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      60,
      expect.objectContaining({ exclude }),
    );
    expect(filename).toHaveBeenCalledWith(
      expect.anything(),
      ["readme"],
      "readme",
      25,
      expect.objectContaining({ exclude }),
    );
    expect(folders).toHaveBeenCalledWith(
      expect.anything(),
      ["readme"],
      "readme",
      50,
      expect.objectContaining({ exclude }),
    );
  });

  it("skips a filename hit whose file id is not returned by filesByIds", async () => {
    const indexQueries = fakeIndexQueries({
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
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [],
    });
    const service = createSearchService(buildDeps({ indexQueries, clock }));

    const result = await service.search(baseInput());

    expect(result.tookMs).toBeGreaterThan(0);
  });
});

describe("createSearchService: search - typos", () => {
  function nameHit(id: number, path: string, ageDays = 0): NameIndexHit {
    return { id, rootId: 1, path, mtimeNs: NOW_NS - BigInt(ageDays) * DAY_NS };
  }

  function nameIndex(hits: Partial<NameIndexHits> | null) {
    return {
      search: vi.fn<NameIndexClient["search"]>(async () =>
        hits === null ? null : { files: hits.files ?? [], folders: hits.folders ?? [] },
      ),
    };
  }

  it("lists a folder found with a typo after every folder spelled as typed", async () => {
    const service = createSearchService(
      buildDeps({
        indexQueries: folderOnlyQueries([makeFolder("alice/Microlärsätt", 3000)]),
        nameIndex: nameIndex({
          folders: [
            folderHitOf("alice/Mikrolärande", 0),
            folderHitOf("alice/Microlärsätt", 3000),
            folderHitOf("alice/Something else", 0),
          ],
        }),
      }),
    );

    const result = await service.search(baseInput({ query: "Microlär" }));

    expect(result.sections.folders.map((folder) => folder.path)).toEqual([
      "/Microlärsätt",
      "/Mikrolärande",
    ]);
  });

  it("ranks a file found with a typo below names spelled as typed and above content matches", async () => {
    const typed = makeFile({
      id: 1,
      path: "alice/Microlär plan.pdf",
      name: "Microlär plan.pdf",
      mtimeNs: daysAgoNs(3000),
    });
    const typo = makeFile({
      id: 2,
      path: "alice/Mikrolärande.pdf",
      name: "Mikrolärande.pdf",
      mtimeNs: daysAgoNs(0),
    });
    const content = makeFile({
      id: 3,
      path: "alice/notes.txt",
      name: "notes.txt",
      mtimeNs: daysAgoNs(0),
    });
    const filesByIds = vi.fn(async () => [typed, typo, content]);
    const indexQueries = fakeIndexQueries({
      semantic: async () => [],
      fulltext: async () => [{ fileId: 3, snippet: "microlär" }],
      filename: async () => [{ fileId: 1, hits: 1, similarity: 0.5 }],
      filesByIds,
    });
    const service = createSearchService(
      buildDeps({
        indexQueries,
        nameIndex: nameIndex({
          files: [
            nameHit(1, "alice/Microlär plan.pdf", 3000),
            nameHit(2, "alice/Mikrolärande.pdf"),
            nameHit(4, "alice/Unrelated.pdf"),
          ],
        }),
      }),
    );

    const result = await service.search(baseInput({ query: "Microlär" }));

    expect(result.sections.files.map((hit) => hit.name)).toEqual([
      "Microlär plan.pdf",
      "Mikrolärande.pdf",
      "notes.txt",
    ]);
    // A hit fdrive would not call a match is never even loaded.
    expect(filesByIds).toHaveBeenLastCalledWith(expect.not.arrayContaining([4]));
  });

  it("asks the name index about the same places with fdrive's own folders left out", async () => {
    const names = nameIndex({});
    const service = createSearchService(
      buildDeps({
        indexQueries: folderOnlyQueries([]),
        nameIndex: names,
      }),
    );

    await service.search(baseInput({ query: "Microlär" }));
    await service.search(
      baseInput({ query: "Microlär", filters: { ...NO_FILTERS, exts: [".pdf"] } }),
    );

    expect(names.search).toHaveBeenNthCalledWith(1, {
      query: "Microlär",
      scopes: [{ rootId: 1, fsPrefix: "/alice" }],
      exclude: reserved(),
      files: 25,
      folders: 50,
    });
    // A type filter is files-only.
    expect(names.search).toHaveBeenNthCalledWith(2, expect.objectContaining({ folders: 0 }));
  });

  it("does not ask the name index about a query with no words", async () => {
    const names = nameIndex({});
    const service = createSearchService(
      buildDeps({ indexQueries: folderOnlyQueries([]), nameIndex: names }),
    );

    await service.search(baseInput({ query: " - " }));

    expect(names.search).not.toHaveBeenCalled();
  });

  it.each([
    ["has no answer", nameIndex(null)],
    ["fails", { search: vi.fn(async () => Promise.reject(new Error("down"))) }],
  ])("finds names only as typed when the name index %s", async (_, names) => {
    const service = createSearchService(
      buildDeps({
        indexQueries: folderOnlyQueries([makeFolder("alice/Microlärsätt", 1)]),
        nameIndex: names,
      }),
    );

    const result = await service.search(baseInput({ query: "Microlär" }));

    expect(result.sections.folders.map((folder) => folder.path)).toEqual(["/Microlärsätt"]);
    expect(result.partial).toBeUndefined();
  });

  it("reports partial when the name index fills its limit", async () => {
    const folders = Array.from({ length: 50 }, (_, i) => folderHitOf(`alice/Mikrolärande ${i}`, i));
    const service = createSearchService(
      buildDeps({ indexQueries: folderOnlyQueries([]), nameIndex: nameIndex({ folders }) }),
    );

    const result = await service.search(baseInput({ query: "Microlär" }));

    expect(result.partial).toBe(true);
    expect(result.sections.folders).toHaveLength(5);
  });

  let nextFolderId = 100;
  function folderHitOf(path: string, ageDays: number): NameIndexHit {
    nextFolderId += 1;
    return nameHit(nextFolderId, path, ageDays);
  }
});
