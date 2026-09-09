import type { Scope } from "@fdrive/core";
import type { ContentHit, FilenameHit, IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type {
  ReadAuthorizeReason,
  ReadAuthorizer,
  ReadAuthorizeTarget,
} from "../scoping/read-authorizer.ts";
import type { EmbedClient } from "./embeddings.js";
import { createSearchService, type SearchServiceDeps, type SearchServiceInput } from "./service.js";

const HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];
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
    directoriesWithFiles: overrides.directoriesWithFiles ?? (async () => []),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
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

/** An authorizer that allows every target unless `denied`/`unavailable` says otherwise. */
function fakeAuthorizer(
  opts: {
    readonly denied?: ReadonlySet<string>;
    readonly unavailable?: ReadonlySet<string>;
    readonly calls?: ReadAuthorizeTarget[];
  } = {},
): ReadAuthorizer {
  return {
    async authorize(target) {
      opts.calls?.push(target);
      const key = `${target.kind}:${target.path}`;
      if (opts.unavailable?.has(key) === true) {
        return { allowed: false, reason: "unavailable" satisfies ReadAuthorizeReason };
      }
      if (opts.denied?.has(key) === true) {
        return { allowed: false, reason: "denied" satisfies ReadAuthorizeReason };
      }
      return { allowed: true };
    },
  };
}

function buildDeps(overrides: Partial<SearchServiceDeps> = {}): SearchServiceDeps {
  return {
    indexQueries: fakeIndexQueries(),
    embedClient: null,
    thumbsEnabled: false,
    trashPath: null,
    clock: () => NOW,
    ...overrides,
  };
}

const NO_FILTERS = { exts: null, folder: null, after: null, before: null };

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
    authorizer: fakeAuthorizer(),
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

  it("is unavailable when none of the scopes' roots have a matching row in the index", async () => {
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

  it("reports partial when the underlying fanout was cut, even with no matches to show", async () => {
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
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
      rootIdsByName: async () => ({ sftpgo: 1 }),
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

  it("drops a hit the authorizer denies, without leaking it via a thumbnail check", async () => {
    const file = makeFile({ id: 51, path: "alice/secret.pdf", ext: ".pdf", sha256: "abc" });
    const thumbnail = vi.fn(async () => ({ storagePath: "x" }));
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 51, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
      thumbnail,
    });
    const service = createSearchService(buildDeps({ indexQueries, thumbsEnabled: true }));
    const authorizer = fakeAuthorizer({ denied: new Set(["file:/secret.pdf"]) });

    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.files).toEqual([]);
    expect(thumbnail).not.toHaveBeenCalled();
    expect(result.partial).toBeUndefined();
  });

  it("marks the response partial when the live-read check reports unavailable", async () => {
    const file = makeFile({ id: 52, path: "alice/flaky.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 52, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const authorizer = fakeAuthorizer({ unavailable: new Set(["file:/flaky.pdf"]) });

    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.files).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("drops a candidate a shadowing override hides, even though its physical location still exists", async () => {
    // "/shared" shadows "alice"'s physical "/alice/shared" subtree; a row
    // still filed under "alice/shared/x.txt" must never surface through
    // the home scope once the more specific override exists.
    const scopes: readonly Scope[] = [
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "sftpgo", fsPrefix: "/team", virtualPrefix: "/shared" },
    ];
    const file = makeFile({ id: 53, path: "alice/shared/x.txt", name: "x.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 53, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));

    const result = await service.search(baseInput({ scopes }));

    expect(result.sections.files).toEqual([]);
  });

  it("respects the limit, applied after inaccessible candidates are removed", async () => {
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

  it("derives up to five authorized folders from the filename query's parent paths", async () => {
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

  it("starts folder authorization before file probes and waits for both", async () => {
    const file = makeFile({ id: 78, path: "alice/folder/report.pdf", name: "report.pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 78, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    let releaseFolder = (): void => fail("releaseFolder");
    const folderBlocked = new Promise<void>((resolve) => {
      releaseFolder = resolve;
    });
    let releaseFile = (): void => fail("releaseFile");
    const fileBlocked = new Promise<void>((resolve) => {
      releaseFile = resolve;
    });
    const calls: ReadAuthorizeTarget[] = [];
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        calls.push(target);
        await (target.kind === "dir" ? folderBlocked : fileBlocked);
        return { allowed: true };
      },
    };
    const service = createSearchService(buildDeps({ indexQueries }));

    const pending = service.search(baseInput({ authorizer }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { path: "/folder", kind: "dir" },
      { path: "/folder/report.pdf", kind: "file" },
    ]);

    releaseFolder();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFile();
    const result = await pending;
    expect(result.sections.folders).toHaveLength(1);
    expect(result.sections.files).toHaveLength(1);
  });

  it("suppresses the Folders section entirely when a type filter is active, even though matching parent folders exist", async () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      makeFile({ id: i + 1, path: `alice/folder${i}/report.pdf`, name: "report.pdf", ext: ".pdf" }),
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

    const result = await service.search(
      baseInput({
        query: "report",
        limit: 100,
        filters: { exts: [".pdf"], folder: null, after: null, before: null },
      }),
    );

    expect(result.sections.folders).toEqual([]);
    // The type filter is files-only: it does not suppress the Files
    // section, only the Folders derivation.
    expect(result.sections.files.length).toBeGreaterThan(0);
  });

  it("never calls the authorizer for a folder while a type filter is active", async () => {
    const file = makeFile({ id: 80, path: "alice/private/x.pdf", name: "x.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 80, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const calls: ReadAuthorizeTarget[] = [];
    const authorizer = fakeAuthorizer({ calls });

    await service.search(
      baseInput({
        authorizer,
        filters: { exts: [".pdf"], folder: null, after: null, before: null },
      }),
    );

    expect(calls.some((call) => call.kind === "dir")).toBe(false);
  });

  it("marks the response partial when a folder's live-read check reports unavailable", async () => {
    const file = makeFile({ id: 65, path: "alice/flaky/report.pdf", ext: ".pdf" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 65, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const authorizer = fakeAuthorizer({ unavailable: new Set(["dir:/flaky"]) });

    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.folders).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("drops a folder the authorizer denies list access to", async () => {
    const file = makeFile({ id: 63, path: "alice/private/x.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 63, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const authorizer = fakeAuthorizer({ denied: new Set(["dir:/private"]) });

    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.folders).toEqual([]);
  });

  it("checks folder access with kind dir, distinct from file checks on the same path", async () => {
    const file = makeFile({ id: 64, path: "alice/private/x.txt" });
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [],
      filename: async () => [{ fileId: 64, hits: 1, similarity: 0.5 }],
      filesByIds: async () => [file],
    });
    const service = createSearchService(buildDeps({ indexQueries }));
    const calls: ReadAuthorizeTarget[] = [];
    const authorizer = fakeAuthorizer({ calls });

    await service.search(baseInput({ authorizer }));

    expect(calls).toContainEqual({ path: "/private/x.txt", kind: "file" });
    expect(calls).toContainEqual({ path: "/private", kind: "dir" });
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

  it("starts content candidate live reads before filename query finishes", async () => {
    const file = makeFile({ id: 81, path: "alice/content.txt", name: "content.txt" });
    let releaseFilename = (): void => fail("releaseFilename");
    const filenameBlocked = new Promise<FilenameHit[]>((resolve) => {
      releaseFilename = () => resolve([]);
    });

    const calls: ReadAuthorizeTarget[] = [];
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        calls.push(target);
        return { allowed: true };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 81, snippet: "content hit" }],
      filename: async () => filenameBlocked,
      filesByIds: async () => [file],
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const pending = service.search(baseInput({ authorizer }));

    await vi.waitFor(() => expect(calls).toContainEqual({ path: "/content.txt", kind: "file" }));

    releaseFilename();
    const result = await pending;
    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]?.path).toBe("/content.txt");
  });

  it("blocks search completion until early content probe settles", async () => {
    const file = makeFile({ id: 82, path: "alice/doc.txt", name: "doc.txt" });
    let releaseAuth = (): void => fail("releaseAuth");
    const authBlocked = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });

    const authorizer: ReadAuthorizer = {
      async authorize() {
        await authBlocked;
        return { allowed: true };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 82, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => [file],
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const pending = service.search(baseInput({ authorizer }));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAuth();
    const result = await pending;
    expect(result.sections.files).toHaveLength(1);
  });

  it("authorizes new path when final metadata differs from primed path without using stale grant", async () => {
    const primedFile = makeFile({ id: 83, path: "alice/old-path.txt", name: "old-path.txt" });
    const finalFile = makeFile({
      id: 83,
      path: "alice/renamed-path.txt",
      name: "renamed-path.txt",
    });

    let filesByIdsCalls = 0;
    const calls: ReadAuthorizeTarget[] = [];
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        calls.push(target);
        if (target.path === "/old-path.txt") {
          return { allowed: true };
        }
        return { allowed: false, reason: "denied" };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 83, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => {
        filesByIdsCalls++;
        return [filesByIdsCalls === 1 ? primedFile : finalFile];
      },
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput({ authorizer }));

    expect(calls).toContainEqual({ path: "/old-path.txt", kind: "file" });
    expect(calls).toContainEqual({ path: "/renamed-path.txt", kind: "file" });
    expect(result.sections.files).toEqual([]);
  });

  it("handles early metadata lookup rejection gracefully without unhandled rejection", async () => {
    const file = makeFile({ id: 84, path: "alice/ok.txt", name: "ok.txt" });
    let filesByIdsCalls = 0;

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 84, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => {
        filesByIdsCalls++;
        if (filesByIdsCalls === 1) {
          throw new Error("early metadata lookup failed");
        }
        return [file];
      },
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput());

    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]?.path).toBe("/ok.txt");
  });

  it("propagates authorizer rejection for a final candidate", async () => {
    const file = makeFile({ id: 85, path: "alice/probe-err.txt", name: "probe-err.txt" });

    const authorizer: ReadAuthorizer = {
      async authorize() {
        throw new Error("storage unreachable");
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 85, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => [file],
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    await expect(service.search(baseInput({ authorizer }))).rejects.toThrow("storage unreachable");
  });

  it("does not set partial flag from an unavailable old-path probe when final metadata points elsewhere and succeeds", async () => {
    const primedFile = makeFile({ id: 86, path: "alice/old-unavail.txt", name: "old-unavail.txt" });
    const finalFile = makeFile({ id: 86, path: "alice/new-ok.txt", name: "new-ok.txt" });

    let filesByIdsCalls = 0;
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        if (target.path === "/old-unavail.txt") {
          return { allowed: false, reason: "unavailable" };
        }
        return { allowed: true };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 86, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => {
        filesByIdsCalls++;
        return [filesByIdsCalls === 1 ? primedFile : finalFile];
      },
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]?.path).toBe("/new-ok.txt");
    expect(result.partial).toBeUndefined();
  });

  it("does not reject or set partial from an old-path probe rejection when final metadata points elsewhere and succeeds", async () => {
    const primedFile = makeFile({ id: 87, path: "alice/old-failed.txt", name: "old-failed.txt" });
    const finalFile = makeFile({ id: 87, path: "alice/new-ok2.txt", name: "new-ok2.txt" });

    let filesByIdsCalls = 0;
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        if (target.path === "/old-failed.txt") {
          throw new Error("old path disconnected");
        }
        return { allowed: true };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 87, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => {
        filesByIdsCalls++;
        return [filesByIdsCalls === 1 ? primedFile : finalFile];
      },
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]?.path).toBe("/new-ok2.txt");
    expect(result.partial).toBeUndefined();
  });

  it("ignores extra metadata rows returned by filesByIds during fanout priming", async () => {
    const fanoutFile = makeFile({ id: 88, path: "alice/expected.txt", name: "expected.txt" });
    const rogueFile = makeFile({ id: 999, path: "alice/rogue.txt", name: "rogue.txt" });

    const calls: ReadAuthorizeTarget[] = [];
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        calls.push(target);
        return { allowed: true };
      },
    };

    let filesByIdsCalls = 0;
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 88, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => {
        filesByIdsCalls++;
        if (filesByIdsCalls === 1) {
          return [fanoutFile, rogueFile];
        }
        return [fanoutFile];
      },
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(baseInput({ authorizer }));

    expect(result.sections.files).toHaveLength(1);
    expect(result.sections.files[0]?.path).toBe("/expected.txt");
    expect(calls).not.toContainEqual({ path: "/rogue.txt", kind: "file" });
  });

  it("skips fanout candidate priming when candidate does not match search filters", async () => {
    const textFile = makeFile({ id: 89, path: "alice/notes.txt", name: "notes.txt", ext: ".txt" });

    const calls: ReadAuthorizeTarget[] = [];
    const authorizer: ReadAuthorizer = {
      async authorize(target) {
        calls.push(target);
        return { allowed: true };
      },
    };

    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1 }),
      semantic: async () => [],
      fulltext: async () => [{ fileId: 89, snippet: "hit" }],
      filename: async () => [],
      filesByIds: async () => [textFile],
    });

    const service = createSearchService(buildDeps({ indexQueries }));
    const result = await service.search(
      baseInput({
        authorizer,
        filters: { exts: [".pdf"], folder: null, after: null, before: null },
      }),
    );

    expect(result.sections.files).toEqual([]);
    expect(calls).toEqual([]);
  });
});
