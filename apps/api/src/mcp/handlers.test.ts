import { type Scope, StorageError, type StorageProvider } from "@fdrive/core";
import type { ActivityListOptions, IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { SearchService } from "../search/service.js";
import type { TokenPrincipal } from "../tokens/principal.ts";
import {
  fileInfoInScope,
  findDuplicatesInScope,
  findFilesInScope,
  folderOverviewInScope,
  indexStatsInScope,
  MAX_CANDIDATE_FILES,
  MAX_RECENT_MOVE_EVENTS,
  type McpToolDeps,
  McpToolError,
  runCreateFolder,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runIndexStats,
  runListDirectory,
  runMovePath,
  runRecentMoves,
  runSearch,
  runSimilarFiles,
  similarFilesInScope,
} from "./handlers.js";
import type { ScopeContext } from "./scope-context.js";
import { resolveScopeContext } from "./scope-context.js";

/** The verified home scope of an identity whose home is "/alice", mapped as the whole root. */
const ALICE_HOME_SCOPES: readonly Scope[] = [
  { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
];

/** A scope covering only "/only", used to exercise the "outside this identity's scope" branches directly. */
const NARROW_SCOPES: readonly Scope[] = [
  { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/only" },
];

const NARROW_SCOPE_CONTEXT: ScopeContext = {
  scopes: NARROW_SCOPES,
  scopePrefixes: [{ rootId: 1, fsPrefix: "/alice" }],
  rootNameById: new Map([[1, "files"]]),
  rootIdByName: new Map([["files", 1]]),
};

/** Like `NARROW_SCOPE_CONTEXT`, but with a root name that has no id yet, to exercise the "root not indexed" branch. */
const UNINDEXED_ROOT_SCOPE_CONTEXT: ScopeContext = {
  scopes: [{ rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" }],
  scopePrefixes: [],
  rootNameById: new Map(),
  rootIdByName: new Map(),
};

/** What alice's index queries leave out: the Trash, the Mac app's folder and the reserved names. */
const ALICE_RESERVED = {
  prefixes: [
    { rootId: 1, fsPrefix: "/alice/.trash" },
    { rootId: 1, fsPrefix: "/alice/.fdrive-desktop" },
  ],
  names: [".fdrive-move-v1"],
};

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function stubIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    folders: overrides.folders ?? (async () => fail("folders")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    contentAt: overrides.contentAt ?? (async () => fail("contentAt")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => ({ files: 1 })),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    fileTextPrefix: overrides.fileTextPrefix ?? (async () => fail("fileTextPrefix")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    thumbnailKeys: overrides.thumbnailKeys ?? (async () => fail("thumbnailKeys")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    photos: overrides.photos ?? (async () => fail("photos")),
    photoDetails: overrides.photoDetails ?? (async () => fail("photoDetails")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
  };
}

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

function fakeDownloadResult(): Awaited<ReturnType<StorageProvider["download"]>> {
  return {
    status: 200,
    body: { cancel: async () => {} } as unknown as ReadableStream<Uint8Array>,
    contentLength: null,
    contentRange: null,
    contentType: null,
    lastModified: null,
  };
}

/** A `StorageProvider` whose `list`/`download` succeed by default. */
function fakeStorage(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    list: overrides.list ?? (async () => []),
    stat:
      overrides.stat ??
      (async () => ({ kind: "file", size: 0, modifiedAt: null, contentType: null })),
    statFile:
      overrides.statFile ??
      (async () => {
        throw new StorageError("not_found", "missing");
      }),
    download: overrides.download ?? (async () => fakeDownloadResult()),
    upload: overrides.upload ?? notImplemented,
    mkdir: overrides.mkdir ?? notImplemented,
    move: overrides.move ?? notImplemented,
    copy: overrides.copy ?? notImplemented,
    deleteFile: overrides.deleteFile ?? notImplemented,
    deleteDir: overrides.deleteDir ?? notImplemented,
    deleteEmptyDir: overrides.deleteEmptyDir ?? notImplemented,
    setModifiedAt: overrides.setModifiedAt ?? notImplemented,
    zip: overrides.zip ?? notImplemented,
    trash: overrides.trash ?? {
      put: notImplemented,
      list: notImplemented,
      restore: notImplemented,
      purge: notImplemented,
    },
  };
}

/** A session principal, as the AI's tools pass to the index-backed handlers: no grants. */
function fakePrincipal(
  storage: StorageProvider = fakeStorage(),
  identityId = "identity-1",
): Principal {
  return {
    accountId: "account-1",
    identityId,
    username: "alice",
    storage,
    isAdmin: false,
  };
}

/** An MCP token's principal: organize access to every folder unless asked otherwise. */
function tokenPrincipal(
  storage: StorageProvider = fakeStorage(),
  mode: "read" | "organize" | "full" = "organize",
  paths: string[] = ["/"],
): TokenPrincipal {
  return { ...fakePrincipal(storage), tokenAccess: { mode, paths } };
}

function fakeSearchService(overrides: Partial<SearchService> = {}): SearchService {
  return {
    search: overrides.search ?? (async () => fail("search")),
  };
}

function makeFile(overrides: Partial<IndexedFile> & { id: number }): IndexedFile {
  return {
    id: overrides.id,
    rootId: overrides.rootId ?? 1,
    path: overrides.path ?? "alice/a.txt",
    name: overrides.name ?? "a.txt",
    ext: overrides.ext ?? ".txt",
    size: overrides.size ?? 100,
    mtimeNs: overrides.mtimeNs ?? 1_700_000_000_000_000_000n,
    sha256: overrides.sha256 ?? null,
    mime: overrides.mime ?? null,
    textStatus: overrides.textStatus ?? "done",
    textChars: overrides.textChars ?? 0,
    error: overrides.error ?? null,
    indexedAt: overrides.indexedAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
  };
}

function baseDeps(overrides: Partial<Parameters<typeof runSearch>[0]> = {}) {
  return {
    indexQueries: stubIndexQueries(),
    searchService: fakeSearchService(),
    scopeResolver: {
      verifiedIndexScopes: async () => ({ available: true as const, scopes: ALICE_HOME_SCOPES }),
    },
    publicUrl: async () => "https://fdrive.example.com",
    indexerClient: null,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function aliceScopeContext(indexQueries: Pick<IndexQueries, "rootIdsByName">) {
  const ctx = await resolveScopeContext(indexQueries, ALICE_HOME_SCOPES);
  if (ctx === null) {
    throw new Error("expected a scope context");
  }
  return ctx;
}

describe("runSearch", () => {
  it("maps results with fdrive URLs", async () => {
    const deps = baseDeps({
      searchService: fakeSearchService({
        search: async () => ({
          query: "invoice",
          sections: {
            folders: [],
            files: [
              {
                path: "/docs/invoice.pdf",
                name: "invoice.pdf",
                kind: "file",
                ext: ".pdf",
                mime: "application/pdf",
                size: 1234,
                modifiedAt: "2026-01-01T00:00:00.000Z",
                score: 0.9,
                snippets: [{ text: "an invoice", ranges: [] }],
                hasThumbnail: false,
              },
            ],
            content: [],
          },
          degraded: false,
          unavailable: false,
          tookMs: 5,
        }),
      }),
    });

    const result = await runSearch(deps, fakePrincipal(), { query: "invoice" });

    expect(result).toEqual({
      query: "invoice",
      results: [
        {
          path: "/docs/invoice.pdf",
          url: "https://fdrive.example.com/view/docs/invoice.pdf",
          name: "invoice.pdf",
          ext: ".pdf",
          size_bytes: 1234,
          modified: "2026-01-01T00:00:00.000Z",
          score: 0.9,
          snippets: ["an invoice"],
        },
      ],
    });
  });

  it("reports unavailable when search has no scope", async () => {
    const deps = baseDeps({
      searchService: fakeSearchService({
        search: async () => ({
          query: "x",
          sections: { folders: [], files: [], content: [] },
          degraded: false,
          unavailable: true,
          tookMs: 1,
        }),
      }),
    });

    const result = await runSearch(deps, fakePrincipal(), { query: "x" });

    expect(result).toEqual({ query: "x", results: [], available: false, unavailable: true });
  });

  it("passes the identity's verified scopes to the search service", async () => {
    const scopes: readonly Scope[] = [
      { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
    ];
    let received: Parameters<SearchService["search"]>[0] | undefined;
    const deps = baseDeps({
      scopeResolver: { verifiedIndexScopes: async () => ({ available: true, scopes }) },
      searchService: fakeSearchService({
        search: async (input) => {
          received = input;
          return {
            query: input.query,
            sections: { folders: [], files: [], content: [] },
            degraded: false,
            unavailable: false,
            tookMs: 0,
          };
        },
      }),
    });

    await runSearch(deps, fakePrincipal(), { query: "report" });

    expect(received?.scopes).toEqual(scopes);
  });

  it("passes an empty scope list when the caller's verified scopes are unavailable", async () => {
    let received: Parameters<SearchService["search"]>[0] | undefined;
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
      searchService: fakeSearchService({
        search: async (input) => {
          received = input;
          return {
            query: input.query,
            sections: { folders: [], files: [], content: [] },
            degraded: false,
            unavailable: true,
            tookMs: 0,
          };
        },
      }),
    });

    await runSearch(deps, fakePrincipal(), { query: "report" });

    expect(received?.scopes).toEqual([]);
  });
});

describe("requireScope (exercised through every index-backed run* wrapper)", () => {
  it("resolves scopes from the principal's own username, never any other value", async () => {
    const verifiedIndexScopes = vi.fn(async (_username: string) => ({
      available: true as const,
      scopes: ALICE_HOME_SCOPES,
    }));
    const deps = baseDeps({
      scopeResolver: { verifiedIndexScopes },
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 0, files: [] }) }),
    });

    await runFindFiles(deps, fakePrincipal(), {});

    expect(verifiedIndexScopes).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it("throws a reason-carrying, path-free error when verified scopes are unavailable", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(
      /unavailable for this identity \(no_roots\)/,
    );
  });

  it("throws when verified scopes are available but land on no indexed root", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "unindexed-root", fsPrefix: "/alice", virtualPrefix: "/" }],
        }),
      },
    });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(McpToolError);
  });
});

describe("runFindFiles / findFilesInScope", () => {
  it("returns files matching the filters within scope", async () => {
    const file = makeFile({ id: 1, path: "alice/report.pdf", ext: ".pdf" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async (prefixes, filter, order, limit) => {
          expect(prefixes).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
          expect(filter.ext).toBe(".pdf");
          expect(order).toBe("modified_desc");
          expect(limit).toBe(50);
          return { total: 1, files: [file] };
        },
      }),
    });

    const result = await runFindFiles(deps, fakePrincipal(), { ext: "pdf" });

    expect(result.total_matches).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ path: "/report.pdf" });
    expect(result.partial).toBeUndefined();
  });

  it("scopes a path_prefix to just that folder", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async (prefixes) => {
          expect(prefixes).toEqual([{ rootId: 1, fsPrefix: "/alice/docs" }]);
          return { total: 0, files: [] };
        },
      }),
    });

    await runFindFiles(deps, fakePrincipal(), { path_prefix: "/docs" });
  });

  it("passes every optional metadata filter through to listFiles", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async (_prefixes, filter) => {
          expect(filter).toEqual({
            exclude: ALICE_RESERVED,
            nameContains: "report",
            modifiedAfterNs: BigInt(new Date("2026-01-01T00:00:00.000Z").getTime()) * 1_000_000n,
            modifiedBeforeNs: BigInt(new Date("2026-02-01T00:00:00.000Z").getTime()) * 1_000_000n,
            minSize: 2 * 1024 * 1024,
          });
          return { total: 0, files: [] };
        },
      }),
    });

    await runFindFiles(deps, fakePrincipal(), {
      name_contains: "report",
      modified_after: "2026-01-01T00:00:00.000Z",
      modified_before: "2026-02-01T00:00:00.000Z",
      min_size_mb: 2,
    });
  });

  it("throws when the index is unavailable", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(McpToolError);
  });

  it("throws when path_prefix does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      findFilesInScope(deps, NARROW_SCOPE_CONTEXT, {
        path_prefix: "/elsewhere",
      }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("filters out a result file that maps to no virtual path in scope", async () => {
    const outOfScope = makeFile({ id: 1, rootId: 999, path: "bob/a.txt" });
    const ctx = await aliceScopeContext(stubIndexQueries());

    const result = await findFilesInScope(
      {
        ...baseDeps(),
        indexQueries: stubIndexQueries({
          listFiles: async () => ({ total: 1, files: [outOfScope] }),
        }),
      },
      ctx,
      {},
    );

    expect(result.results).toEqual([]);
    expect(result.total_matches).toBe(0);
    expect(result.partial).toBe(true);
  });

  it("reports partial when the underlying SQL total exceeds what was fetched", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 500, files: [file] }) }),
    };

    const result = await findFilesInScope(deps, ctx, { limit: 1 });

    expect(result.partial).toBe(true);
  });

  it("handles a literal percent sign in a file's virtual path without corrupting the result", async () => {
    const file = makeFile({ id: 1, path: "alice/50%-off.pdf", name: "50%-off.pdf" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 1, files: [file] }) }),
    };

    const result = await findFilesInScope(deps, ctx, {});

    expect(result.results[0]?.path).toBe("/50%-off.pdf");
  });
});

describe("runListDirectory", () => {
  it("lists entries live via storage", async () => {
    const modifiedAt = new Date("2026-01-01T00:00:00.000Z");
    const storage = fakeStorage({
      list: async (path) => {
        expect(path).toBe("/docs");
        return [
          { name: "a.txt", path: "/docs/a.txt", kind: "file", size: 10, modifiedAt, ext: ".txt" },
          { name: "sub", path: "/docs/sub", kind: "dir", size: 0, modifiedAt, ext: "" },
        ];
      },
    });

    const result = await runListDirectory(baseDeps(), tokenPrincipal(storage), { path: "/docs" });

    expect(result.path).toBe("/docs");
    expect(result.entries).toEqual([
      {
        name: "a.txt",
        type: "file",
        path: "/docs/a.txt",
        size_bytes: 10,
        modified: modifiedAt.toISOString(),
        url: "https://fdrive.example.com/view/docs/a.txt",
      },
      {
        name: "sub",
        type: "dir",
        path: "/docs/sub",
        size_bytes: null,
        modified: modifiedAt.toISOString(),
        url: "https://fdrive.example.com/files/docs/sub",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it.each(["/docs/../docs", "//docs", "/./docs", "/docs/"])(
    "lists the checked path for the unnormalized %s",
    async (path) => {
      const list = vi.fn(async () => []);
      const deps = baseDeps();

      const result = await runListDirectory(deps, tokenPrincipal(fakeStorage({ list })), { path });

      expect(list).toHaveBeenCalledWith("/docs");
      expect(result.path).toBe("/docs");
      expect(result.url).toBe("https://fdrive.example.com/files/docs");
    },
  );

  it("defaults to the root and truncates past the limit", async () => {
    const modifiedAt = new Date();
    const storage = fakeStorage({
      list: async () => [
        { name: "a", path: "/a", kind: "file" as const, size: 1, modifiedAt, ext: "" },
        { name: "b", path: "/b", kind: "file" as const, size: 1, modifiedAt, ext: "" },
      ],
    });

    const result = await runListDirectory(baseDeps(), tokenPrincipal(storage), { limit: 1 });

    expect(result.path).toBe("/");
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("hides the Trash and the Mac app's folder before pagination", async () => {
    const modifiedAt = new Date();
    const storage = fakeStorage({
      list: async () => [
        { name: ".trash", path: "/.trash", kind: "dir" as const, size: 0, modifiedAt, ext: "" },
        {
          name: ".fdrive-desktop",
          path: "/.fdrive-desktop",
          kind: "dir" as const,
          size: 0,
          modifiedAt,
          ext: "",
        },
        { name: "a", path: "/a", kind: "file" as const, size: 1, modifiedAt, ext: "" },
      ],
    });
    const deps = baseDeps();

    const result = await runListDirectory(deps, tokenPrincipal(storage), { limit: 1 });

    expect(result.entries.map((entry) => entry.name)).toEqual(["a"]);
    expect(result.truncated).toBe(false);
  });

  it.each([
    "/.trash",
    "/.trash/deleted.txt",
    "/docs/../.trash",
    "/.fdrive-desktop",
    "/old/.fdrive-move-v1/file",
  ])("rejects %s, in one of fdrive's own folders, before touching storage", async (path) => {
    const list = vi.fn(async () => []);
    const storage = fakeStorage({ list });
    const deps = baseDeps();

    await expect(runListDirectory(deps, tokenPrincipal(storage), { path })).rejects.toThrow(
      "fdrive's own folders",
    );
    expect(list).not.toHaveBeenCalled();
  });
});

describe("fileInfoInScope (the AI's indexed file_info)", () => {
  it("returns file metadata plus identical copies", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt", sha256: "abc" });
    const copy = makeFile({ id: 2, path: "alice/copy/a.txt", sha256: "abc" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        fileByPath: async (rootId, path) => {
          expect(rootId).toBe(1);
          expect(path).toBe("alice/a.txt");
          return file;
        },
        filesBySha256: async () => [copy],
      }),
    });

    const result = await fileInfoInScope(deps, await aliceScopeContext(deps.indexQueries), {
      path: "/a.txt",
    });

    expect(result.path).toBe("/a.txt");
    expect(result.identical_copies).toEqual(["/copy/a.txt"]);
    expect(result.partial).toBeUndefined();
  });

  it("skips the identical-copies lookup entirely for a file with no hash yet", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt", sha256: null });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ fileByPath: async () => file }),
    });

    const result = await fileInfoInScope(deps, await aliceScopeContext(deps.indexQueries), {
      path: "/a.txt",
    });

    expect(result.identical_copies).toEqual([]);
    expect(result.partial).toBeUndefined();
  });

  it("throws when the file is not indexed", async () => {
    const deps = baseDeps({ indexQueries: stubIndexQueries({ fileByPath: async () => null }) });
    await expect(
      fileInfoInScope(deps, await aliceScopeContext(deps.indexQueries), {
        path: "/a.txt",
      }),
    ).rejects.toThrow(/not indexed/);
  });

  it("throws when the path does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      fileInfoInScope(deps, NARROW_SCOPE_CONTEXT, { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws when the resolved root has no id in the index yet", async () => {
    const deps = baseDeps();
    await expect(
      fileInfoInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, { path: "/a.txt" }),
    ).rejects.toThrow(/not indexed yet/);
  });

  it("throws when the found file maps to no virtual path in scope", async () => {
    const foreignFile = makeFile({ id: 1, rootId: 999, path: "alice/a.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ fileByPath: async () => foreignFile }),
    });

    await expect(
      fileInfoInScope(deps, await aliceScopeContext(deps.indexQueries), {
        path: "/a.txt",
      }),
    ).rejects.toThrow(/not indexed yet/);
  });

  it("caps identical copies at MAX_CANDIDATE_FILES and reports partial", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt", sha256: "abc" });
    const copies = Array.from({ length: MAX_CANDIDATE_FILES + 1 }, (_, i) =>
      makeFile({ id: i + 2, path: `alice/copy-${i}.txt`, sha256: "abc" }),
    );
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        fileByPath: async () => file,
        filesBySha256: async () => copies,
      }),
    };

    const result = await fileInfoInScope(deps, ctx, { path: "/a.txt" });

    expect(result.identical_copies).toHaveLength(MAX_CANDIDATE_FILES);
    expect(result.partial).toBe(true);
  });
});

describe("runFindDuplicates / findDuplicatesInScope", () => {
  it("returns duplicate groups with mapped paths", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        duplicates: async () => [
          {
            sha256: "abc",
            size: 100,
            count: 2,
            files: [
              { rootId: 1, path: "alice/a.txt" },
              { rootId: 1, path: "alice/b.txt" },
            ],
          },
        ],
      }),
    });

    const result = await runFindDuplicates(deps, fakePrincipal(), {});

    expect(result.total_groups).toBe(1);
    expect(result.total_wasted_bytes).toBe(100);
    expect(result.groups[0]?.paths).toEqual(["/a.txt", "/b.txt"]);
    expect(result.partial).toBeUndefined();
  });

  it("scopes a path_prefix to just that folder", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        duplicates: async (prefixes) => {
          expect(prefixes).toEqual([{ rootId: 1, fsPrefix: "/alice/docs" }]);
          return [];
        },
      }),
    });

    await runFindDuplicates(deps, fakePrincipal(), { path_prefix: "/docs" });
  });

  it("throws when path_prefix does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      findDuplicatesInScope(deps, NARROW_SCOPE_CONTEXT, {
        path_prefix: "/elsewhere",
      }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("drops a group entirely when every one of its locations maps to no virtual path in scope", async () => {
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        duplicates: async () => [
          {
            sha256: "abc",
            size: 100,
            count: 2,
            files: [
              { rootId: 999, path: "bob/a.txt" },
              { rootId: 999, path: "bob/b.txt" },
            ],
          },
        ],
      }),
    };

    const result = await findDuplicatesInScope(deps, ctx, {});

    expect(result.groups).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("keeps a group with three copies when exactly one is out of scope, recomputing wasted bytes from survivors only", async () => {
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        duplicates: async () => [
          {
            sha256: "abc",
            size: 100,
            count: 3,
            files: [
              { rootId: 1, path: "alice/a.txt" },
              { rootId: 1, path: "alice/b.txt" },
              { rootId: 1, path: "bob/secret.txt" },
            ],
          },
        ],
      }),
    };

    const result = await findDuplicatesInScope(deps, ctx, {});

    expect(result.groups).toEqual([
      {
        sha256: "abc",
        size_bytes: 100,
        copies: 2,
        wasted_bytes: 100,
        paths: ["/a.txt", "/b.txt"],
      },
    ]);
    expect(result.partial).toBe(true);
  });

  it("caps the total examined locations across every group at MAX_CANDIDATE_FILES", async () => {
    const ctx = await aliceScopeContext(stubIndexQueries());
    const bigGroupFiles = Array.from({ length: 1500 }, (_, i) => ({
      rootId: 1,
      path: `alice/g2-${i}.txt`,
    }));
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        duplicates: async () => [
          {
            sha256: "g1",
            size: 10,
            count: 1000,
            files: Array.from({ length: 1000 }, (_, i) => ({
              rootId: 1,
              path: `alice/g1-${i}.txt`,
            })),
          },
          { sha256: "g2", size: 10, count: 1500, files: bigGroupFiles },
        ],
      }),
    };

    const result = await findDuplicatesInScope(deps, ctx, {});

    const totalCopies = result.groups.reduce((sum, group) => sum + group.copies, 0);
    expect(totalCopies).toBe(MAX_CANDIDATE_FILES);
    expect(result.partial).toBe(true);
  });
});

describe("runSimilarFiles / similarFilesInScope", () => {
  it("returns similar files ranked by similarity", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const near = makeFile({ id: 2, path: "alice/near.md" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => [{ fileId: 2, similarity: 0.987654 }],
        filesByIds: async () => [near],
      }),
    });

    const result = await runSimilarFiles(deps, fakePrincipal(), { path: "/target.md" });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ path: "/near.md", similarity: 0.9877 });
    expect(result.partial).toBeUndefined();
  });

  it("returns no results when nothing is similar", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => [],
      }),
    });

    const result = await runSimilarFiles(deps, fakePrincipal(), { path: "/target.md" });

    expect(result).toEqual({ path: "/target.md", results: [] });
  });

  it("throws when the file is not indexed", async () => {
    const deps = baseDeps({ indexQueries: stubIndexQueries({ fileByPath: async () => null }) });
    await expect(runSimilarFiles(deps, fakePrincipal(), { path: "/x.md" })).rejects.toThrow(
      /not indexed/,
    );
  });

  it("throws when the path does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      similarFilesInScope(deps, NARROW_SCOPE_CONTEXT, { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws when the resolved root has no id in the index yet", async () => {
    const deps = baseDeps();
    await expect(
      similarFilesInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, {
        path: "/target.md",
      }),
    ).rejects.toThrow(/not indexed yet/);
  });

  it("throws the same message when the indexed file itself belongs to a different root", async () => {
    const foreignFile = makeFile({ id: 1, rootId: 999, path: "bob/target.md" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ fileByPath: async () => foreignFile }),
    };

    await expect(similarFilesInScope(deps, ctx, { path: "/target.md" })).rejects.toThrow(
      /not indexed/,
    );
  });

  it("skips a similar row whose file id is missing from filesByIds", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => [{ fileId: 2, similarity: 0.9 }],
        filesByIds: async () => [],
      }),
    });

    const result = await runSimilarFiles(deps, fakePrincipal(), { path: "/target.md" });

    expect(result.results).toEqual([]);
  });

  it("skips a similar file that maps to no virtual path in scope", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const foreign = makeFile({ id: 2, rootId: 999, path: "bob/near.md" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => [{ fileId: 2, similarity: 0.9 }],
        filesByIds: async () => [foreign],
      }),
    });

    const result = await runSimilarFiles(deps, fakePrincipal(), { path: "/target.md" });

    expect(result.results).toEqual([]);
  });
});

describe("runFolderOverview / folderOverviewInScope", () => {
  it("aggregates files by folder", async () => {
    const files = [
      makeFile({ id: 1, path: "alice/docs/a.pdf", ext: ".pdf", size: 100, mtimeNs: 1n }),
      makeFile({ id: 2, path: "alice/docs/b.pdf", ext: ".pdf", size: 200, mtimeNs: 2n }),
      makeFile({ id: 3, path: "alice/photos/c.jpg", ext: ".jpg", size: 50, mtimeNs: 3n }),
    ];
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 3, files }),
      }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    expect(result.total_files).toBe(3);
    expect(result.total_bytes).toBe(350);
    const byPath = new Map(result.folders.map((f) => [f.path, f]));
    expect(byPath.get("/docs")).toMatchObject({ files: 2, bytes: 300 });
    expect(byPath.get("/photos")).toMatchObject({ files: 1, bytes: 50 });
    expect(result.truncated).toBe(false);
  });

  it("reports truncated when more files exist than were loaded", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 100, files: [makeFile({ id: 1 })] }),
      }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    expect(result.truncated).toBe(true);
  });

  it("throws when path_prefix does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      folderOverviewInScope(deps, NARROW_SCOPE_CONTEXT, {
        path_prefix: "/elsewhere",
      }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("ranks a folder's top file types by count", async () => {
    const files = [
      makeFile({ id: 1, path: "alice/docs/a.pdf", ext: ".pdf" }),
      makeFile({ id: 2, path: "alice/docs/b.pdf", ext: ".pdf" }),
      makeFile({ id: 3, path: "alice/docs/c.txt", ext: ".txt" }),
    ];
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 3, files }) }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    const docs = result.folders.find((f) => f.path === "/docs");
    expect(docs?.top_types).toEqual([
      { ext: ".pdf", count: 2 },
      { ext: ".txt", count: 1 },
    ]);
  });

  it('groups an extensionless file under "(none)" and reports no newest date for an epoch mtime', async () => {
    const files = [makeFile({ id: 1, path: "alice/docs/README", ext: "", mtimeNs: 0n })];
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 1, files }) }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    const docs = result.folders.find((f) => f.path === "/docs");
    expect(docs?.top_types).toEqual([{ ext: "(none)", count: 1 }]);
    expect(docs?.newest).toBeNull();
  });

  it("skips a file that maps to no virtual path in scope", async () => {
    const outOfScope = makeFile({ id: 1, rootId: 999, path: "bob/a.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 1, files: [outOfScope] }),
      }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    expect(result.folders).toEqual([]);
    expect(result.total_bytes).toBe(0);
    expect(result.total_files).toBe(0);
  });
});

describe("runIndexStats / indexStatsInScope", () => {
  it.each([
    ["organize", true],
    ["read", false],
  ] as const)(
    "returns stats from the files in scope, and writes_enabled for a %s token",
    async (mode, writesEnabled) => {
      const files = [
        makeFile({ id: 1, path: "alice/a.txt", size: 100, textStatus: "done" }),
        makeFile({ id: 2, path: "alice/b.txt", size: 50, textStatus: "done" }),
      ];
      const deps = baseDeps({
        indexQueries: stubIndexQueries({
          listFiles: async () => ({ total: 2, files }),
          statsForFileIds: async (ids) => {
            expect([...ids].sort()).toEqual([1, 2]);
            return { chunks: 5, chunksEmbedded: 5 };
          },
        }),
      });

      const result = await runIndexStats(deps, tokenPrincipal(fakeStorage(), mode));

      expect(result).toEqual({
        files_tracked: 2,
        by_text_status: [{ status: "done", files: 2, bytes: 150 }],
        chunks: 5,
        chunks_embedded: 5,
        writes_enabled: writesEnabled,
      });
    },
  );

  it("leaves a row out of scope out of every count and reports partial", async () => {
    const files = [
      makeFile({ id: 1, path: "alice/a.txt", size: 100 }),
      makeFile({ id: 2, path: "bob/b.txt", size: 50 }),
    ];
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 2, files }),
        statsForFileIds: async (ids) => {
          expect(ids).toEqual([1]);
          return { chunks: 1, chunksEmbedded: 1 };
        },
      }),
    });

    const result = await indexStatsInScope(deps, ctx);

    expect(result).toMatchObject({ files_tracked: 1, partial: true });
  });
});

describe("runCreateFolder", () => {
  it("refuses a read token", async () => {
    const mkdir = vi.fn(async () => undefined);
    await expect(
      runCreateFolder(baseDeps(), tokenPrincipal(fakeStorage({ mkdir }), "read"), {
        path: "/new",
      }),
    ).rejects.toThrow("this token does not allow organize operations");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("creates a folder for an organize token", async () => {
    const mkdir = vi.fn(async () => undefined);

    const result = await runCreateFolder(baseDeps(), tokenPrincipal(fakeStorage({ mkdir })), {
      path: "/new",
    });

    expect(mkdir).toHaveBeenCalledWith("/new", { parents: true });
    expect(result).toEqual({ created: "/new", url: "https://fdrive.example.com/files/new" });
  });

  it.each(["/docs/../new", "//new", "/./new", "/new/", "/new/sub/.."])(
    "creates the folder at the admitted path for the unnormalized %s",
    async (path) => {
      const mkdir = vi.fn(async () => undefined);

      const result = await runCreateFolder(baseDeps(), tokenPrincipal(fakeStorage({ mkdir })), {
        path,
      });

      // The provider forwards this string verbatim, so it must be the exact
      // path the admission was decided on, not the caller's argument.
      expect(mkdir).toHaveBeenCalledWith("/new", { parents: true });
      expect(result).toEqual({ created: "/new", url: "https://fdrive.example.com/files/new" });
    },
  );

  it("leaves characters normalization must not touch byte-identical", async () => {
    const mkdir = vi.fn(async () => undefined);

    const result = await runCreateFolder(baseDeps(), tokenPrincipal(fakeStorage({ mkdir })), {
      path: "/a b/50%-off & #1..2",
    });

    expect(mkdir).toHaveBeenCalledWith("/a b/50%-off & #1..2", { parents: true });
    expect(result.created).toBe("/a b/50%-off & #1..2");
  });

  it.each(["/.trash", "/.trash/deleted.txt", "/docs/../.trash"])(
    "refuses the Trash path %s before touching storage",
    async (path) => {
      const mkdir = vi.fn(async () => undefined);
      const deps = baseDeps();

      await expect(
        runCreateFolder(deps, tokenPrincipal(fakeStorage({ mkdir })), { path }),
      ).rejects.toThrow("fdrive's own folders");
      expect(mkdir).not.toHaveBeenCalled();
    },
  );

  it.each(["/private/new", "/docs/../private/new"])(
    "refuses %s outside the token's folders without touching storage",
    async (path) => {
      const mkdir = vi.fn(async () => undefined);
      const principal = tokenPrincipal(fakeStorage({ mkdir }), "organize", ["/docs"]);

      await expect(runCreateFolder(baseDeps(), principal, { path })).rejects.toThrow(
        "outside this token's allowed folders",
      );
      expect(mkdir).not.toHaveBeenCalled();
    },
  );

  it("needs no index and reports a failed live update as a warning", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
      onMutation: async () => {
        throw new Error("events unavailable");
      },
    });

    const result = await runCreateFolder(deps, tokenPrincipal(fakeStorage({ mkdir })), {
      path: "/new",
    });

    expect(mkdir).toHaveBeenCalledOnce();
    expect(result.warnings).toEqual([expect.stringContaining("live updates")]);
  });
});

describe("runMovePath", () => {
  it("leaves refusing an occupied destination to storage, checking nothing first", async () => {
    const statFile = vi.fn();
    const move = vi.fn(async () => {
      throw new StorageError("conflict", "something already exists at /b");
    });
    const storage = fakeStorage({ move, statFile });
    await expect(
      runMovePath(baseDeps(), tokenPrincipal(storage), { src: "/a", dst: "/b" }),
    ).rejects.toThrow("already exists");
    expect(move).toHaveBeenCalledWith("/a", "/b");
    expect(statFile).not.toHaveBeenCalled();
  });

  it("reports a completed move with a warning when metadata fails", async () => {
    const move = vi.fn();
    const deps = baseDeps({
      onMutation: async () => {
        throw new Error("metadata unavailable");
      },
    });
    const result = await runMovePath(deps, tokenPrincipal(fakeStorage({ move })), {
      src: "/a",
      dst: "/b",
    });
    expect(result).toMatchObject({
      moved: "/a",
      to: "/b",
      warnings: [expect.stringContaining("metadata")],
    });
    expect(move).toHaveBeenCalledOnce();
  });

  it("does not mutate or run the hook for a same-path move", async () => {
    const move = vi.fn();
    const onMutation = vi.fn();
    await runMovePath(baseDeps({ onMutation }), tokenPrincipal(fakeStorage({ move })), {
      src: "/a",
      dst: "/a",
    });
    expect(move).not.toHaveBeenCalled();
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("uses storage kind for a dotted directory and runs the mutation hook", async () => {
    const onMutation = vi.fn();
    const storage = fakeStorage({
      move: async () => {},
      stat: async () => ({ kind: "dir", size: 0, modifiedAt: null, contentType: null }),
    });
    const result = await runMovePath(baseDeps({ onMutation }), tokenPrincipal(storage), {
      src: "/a",
      dst: "/archive.2026",
    });
    expect(result.url).toBe("https://fdrive.example.com/files/archive.2026");
    expect(onMutation).toHaveBeenCalledWith(expect.anything(), {
      kind: "move",
      path: "/a",
      target: "/archive.2026",
      isDir: true,
    });
  });

  it("refuses a read token", async () => {
    const move = vi.fn(async () => undefined);
    await expect(
      runMovePath(baseDeps(), tokenPrincipal(fakeStorage({ move }), "read"), {
        src: "/a.txt",
        dst: "/b.txt",
      }),
    ).rejects.toThrow("this token does not allow organize operations");
    expect(move).not.toHaveBeenCalled();
  });

  it("moves without any index", async () => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });

    const result = await runMovePath(deps, tokenPrincipal(fakeStorage({ move })), {
      src: "/a.txt",
      dst: "/b.txt",
    });

    expect(move).toHaveBeenCalledWith("/a.txt", "/b.txt");
    expect(result).toEqual({
      moved: "/a.txt",
      to: "/b.txt",
      url: "https://fdrive.example.com/view/b.txt",
    });
  });

  it.each([
    ["/docs/../a.txt", "//b.txt"],
    ["/./a.txt", "/b.txt/"],
    ["/a.txt/", "/sub/../b.txt"],
  ])("moves the admitted paths for the unnormalized %s -> %s", async (src, dst) => {
    const move = vi.fn(async () => undefined);

    const result = await runMovePath(baseDeps(), tokenPrincipal(fakeStorage({ move })), {
      src,
      dst,
    });

    // The provider forwards both strings verbatim, so both must be the exact
    // paths the admission was decided on.
    expect(move).toHaveBeenCalledWith("/a.txt", "/b.txt");
    expect(result.moved).toBe("/a.txt");
    expect(result.to).toBe("/b.txt");
  });

  it.each([
    ["src", { src: "/.trash/deleted.txt", dst: "/b.txt" }],
    ["src", { src: "/docs/../.trash", dst: "/b.txt" }],
    ["dst", { src: "/a.txt", dst: "/.trash" }],
    ["dst", { src: "/a.txt", dst: "/docs/../.trash/a.txt" }],
  ])("refuses a %s in the Trash before touching storage", async (_label, args) => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps();

    await expect(runMovePath(deps, tokenPrincipal(fakeStorage({ move })), args)).rejects.toThrow(
      "fdrive's own folders",
    );
    expect(move).not.toHaveBeenCalled();
  });

  it.each([
    { src: "/docs/../private/a.txt", dst: "/docs/b.txt" },
    { src: "/docs/a.txt", dst: "/docs/../private/b.txt" },
    { src: "/elsewhere/a.txt", dst: "/docs/b.txt" },
    { src: "/docs/a.txt", dst: "/elsewhere/b.txt" },
  ])("refuses a move leaving the token's folders: %o", async (args) => {
    const move = vi.fn(async () => undefined);
    const principal = tokenPrincipal(fakeStorage({ move }), "organize", ["/docs"]);

    await expect(runMovePath(baseDeps(), principal, args)).rejects.toThrow(
      "outside this token's allowed folders",
    );
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses to move a grant root", async () => {
    const move = vi.fn(async () => undefined);
    const principal = tokenPrincipal(fakeStorage({ move }), "organize", ["/docs"]);

    await expect(
      runMovePath(baseDeps(), principal, { src: "/docs", dst: "/docs/inner" }),
    ).rejects.toThrow("cannot move or delete an allowed folder root");
    expect(move).not.toHaveBeenCalled();
  });

  it("uses storage kind for an extensionless file in the returned url", async () => {
    const result = await runMovePath(
      baseDeps(),
      tokenPrincipal(fakeStorage({ move: async () => undefined })),
      { src: "/a", dst: "/folder" },
    );

    expect(result.url).toBe("https://fdrive.example.com/view/folder");
  });
});

describe("runRecentMoves", () => {
  const at = new Date("2026-01-02T03:04:05.000Z");
  let next = 0;
  function moveEvent(
    src: string | undefined,
    dst: string | undefined,
    occurredAt: Date | null = at,
  ) {
    next += 1;
    return {
      id: `event-${next}`,
      sortAt: new Date(at.getTime() - next),
      occurredAt,
      before: src === undefined ? null : { path: src, kind: "file" as const },
      after: dst === undefined ? null : { path: dst },
    };
  }
  /** Personal activity whose `list` answers from `pages` in turn and records each call. */
  function activityOf(...pages: ReturnType<typeof moveEvent>[][]) {
    const list = vi.fn(
      async (_accountId: string, _options: ActivityListOptions) => pages.shift() ?? [],
    );
    return {
      list,
      deps: baseDeps({
        activity: { repo: { list } } as unknown as NonNullable<McpToolDeps["activity"]>,
      }),
    };
  }

  it("asks for the caller's own successful MCP moves, of its account and login only", async () => {
    const { list, deps } = activityOf([moveEvent("/a.txt", "/b.txt")]);

    const result = await runRecentMoves(deps, tokenPrincipal(), {});

    expect(result).toEqual({ moves: [{ at: at.toISOString(), src: "/a.txt", dst: "/b.txt" }] });
    expect(list).toHaveBeenCalledWith("account-1", {
      identityId: "identity-1",
      action: "file.move",
      source: "mcp",
      outcome: "success",
      limit: 100,
    });
  });

  it("returns no moves without personal activity", async () => {
    expect(await runRecentMoves(baseDeps(), tokenPrincipal(), {})).toEqual({ moves: [] });
  });

  it("lists only moves with both ends in the token's folders and outside fdrive's own", async () => {
    const { deps } = activityOf([
      moveEvent("/docs/a.txt", "/docs/b.txt"),
      moveEvent("/docs/c.txt", "/private/c.txt"),
      moveEvent("/private/d.txt", "/docs/d.txt"),
      moveEvent("/docs/e.txt", "/docs/.fdrive-move-v1/e.txt"),
      moveEvent("/docs/old/.fdrive-move-v1/f.txt", "/docs/f.txt"),
      moveEvent(undefined, "/docs/g.txt"),
      moveEvent("/docs/h.txt", undefined),
    ]);

    const result = await runRecentMoves(deps, tokenPrincipal(fakeStorage(), "read", ["/docs"]), {});

    expect(result).toEqual({
      moves: [{ at: at.toISOString(), src: "/docs/a.txt", dst: "/docs/b.txt" }],
    });
  });

  it("falls back to the sort time for an event without an occurrence time", async () => {
    const event = moveEvent("/a.txt", "/b.txt", null);
    const { deps } = activityOf([event]);

    const result = await runRecentMoves(deps, tokenPrincipal(), {});

    expect(result.moves).toEqual([
      { at: event.sortAt.toISOString(), src: "/a.txt", dst: "/b.txt" },
    ]);
  });

  it("pages on from the last event until the limit is filled, then stops", async () => {
    const outside = Array.from({ length: 100 }, () => moveEvent("/private/x", "/private/y"));
    const second = [moveEvent("/docs/a", "/docs/b"), moveEvent("/docs/c", "/docs/d")];
    const { list, deps } = activityOf(outside, second);

    const result = await runRecentMoves(deps, tokenPrincipal(fakeStorage(), "read", ["/docs"]), {
      limit: 1,
    });

    expect(result).toEqual({ moves: [{ at: at.toISOString(), src: "/docs/a", dst: "/docs/b" }] });
    const last = outside.at(-1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[1]).toMatchObject({ after: { at: last?.sortAt, id: last?.id } });
  });

  it("clamps the limit and reports partial once it has read its bound", async () => {
    const pages = Array.from({ length: MAX_RECENT_MOVE_EVENTS / 100 + 1 }, () =>
      Array.from({ length: 100 }, () => moveEvent("/private/x", "/private/y")),
    );
    const { list, deps } = activityOf(...pages);

    const result = await runRecentMoves(deps, tokenPrincipal(fakeStorage(), "read", ["/docs"]), {
      limit: 10_000,
    });

    expect(result).toEqual({ moves: [], partial: true });
    expect(list).toHaveBeenCalledTimes(MAX_RECENT_MOVE_EVENTS / 100);
  });
});

describe("fdrive's own folders", () => {
  const exclude = ALICE_RESERVED;

  it("asks every index query to leave them out before its limit", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md", sha256: "s" });
    const listFiles = vi.fn(async () => ({ total: 0, files: [] }));
    const filesBySha256 = vi.fn(async () => []);
    const duplicates = vi.fn(async () => []);
    const similar = vi.fn(async () => []);
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles,
        filesBySha256,
        duplicates,
        similar,
        fileByPath: async () => target,
        statsForFileIds: async () => ({ chunks: 0, chunksEmbedded: 0 }),
      }),
    });
    const principal = tokenPrincipal();
    const ctx = await resolveScopeContext(deps.indexQueries, ALICE_HOME_SCOPES);
    if (ctx === null) throw new Error("expected a scope context");

    await runFindFiles(deps, principal, {});
    await runFolderOverview(deps, principal, {});
    await runIndexStats(deps, principal);
    await fileInfoInScope(deps, ctx, { path: "/target.md" });
    await runFindDuplicates(deps, principal, {});
    await runSimilarFiles(deps, principal, { path: "/target.md" });

    expect(listFiles.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ exclude }),
      { exclude },
      { exclude },
    ]);
    expect(filesBySha256).toHaveBeenCalledWith(expect.anything(), "s", 1, { exclude });
    expect(duplicates).toHaveBeenCalledWith(expect.anything(), expect.any(Number), 40, {
      exclude,
    });
    expect(similar).toHaveBeenCalledWith(1, expect.anything(), 10, { exclude });
  });

  it("never maps an index row into one, even one a lookup by path finds", async () => {
    const ctx = await resolveScopeContext(stubIndexQueries(), ALICE_HOME_SCOPES);
    if (ctx === null) throw new Error("expected a scope context");
    for (const path of [
      "alice/.trash/a.txt",
      "alice/.fdrive-desktop/staging/a.txt",
      "alice/old/.fdrive-move-v1/file/p/a.txt/v/1",
    ]) {
      const file = makeFile({ id: 1, path });
      const deps = baseDeps({ indexQueries: stubIndexQueries({ fileByPath: async () => file }) });
      await expect(fileInfoInScope(deps, ctx, { path: `/${path.slice(6)}` })).rejects.toThrow(
        "not indexed",
      );
    }
  });
});
