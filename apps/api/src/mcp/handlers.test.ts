import { type Scope, StorageError, type StorageProvider } from "@fdrive/core";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { ReadAuthorizeResult, ReadAuthorizer } from "../scoping/read-authorizer.ts";
import { buildIdentity } from "../scoping/test-fixtures/index.ts";
import type { SearchService } from "../search/service.js";
import {
  fileInfoInScope,
  findDuplicatesInScope,
  findFilesInScope,
  folderOverviewInScope,
  indexStatsInScope,
  MAX_CANDIDATE_FILES,
  McpToolError,
  readFileTextWithScopes,
  recentMovesInScope,
  recordMoveIfInScope,
  runCreateFolder,
  runFileInfo,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runIndexStats,
  runListDirectory,
  runMovePath,
  runReadFileText,
  runRecentMoves,
  runSearch,
  runSimilarFiles,
  similarFilesInScope,
} from "./handlers.js";
import type { ScopeContext } from "./scope-context.js";
import { resolveScopeContext } from "./scope-context.js";

/** The verified home scope of an identity whose SFTPGo home is "/alice", mapped as the whole root. */
const ALICE_HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];

/** A scope covering only "/only", used to exercise the "outside this identity's scope" branches directly. */
const NARROW_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/only" },
];

const NARROW_SCOPE_CONTEXT: ScopeContext = {
  scopes: NARROW_SCOPES,
  scopePrefixes: [{ rootId: 1, fsPrefix: "/alice" }],
  rootNameById: new Map([[1, "sftpgo"]]),
  rootIdByName: new Map([["sftpgo", 1]]),
  trashPath: null,
};

/** Like `NARROW_SCOPE_CONTEXT`, but with a root name that has no id yet, to exercise the "root not indexed" branch. */
const UNINDEXED_ROOT_SCOPE_CONTEXT: ScopeContext = {
  scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
  scopePrefixes: [],
  rootNameById: new Map(),
  rootIdByName: new Map(),
  trashPath: null,
};

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function stubIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => ({ sftpgo: 1 })),
    directoriesWithFiles: overrides.directoriesWithFiles ?? (async () => []),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    fileTextPrefix: overrides.fileTextPrefix ?? (async () => fail("fileTextPrefix")),
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

/**
 * A `StorageProvider` whose `list`/`download` succeed by default (so a
 * `run*` wrapper's real `ReadAuthorizer`, built from `principal.storage`,
 * allows everything unless a test deliberately overrides one of these two
 * methods to deny a specific path).
 */
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
    setModifiedAt: overrides.setModifiedAt ?? notImplemented,
    zip: overrides.zip ?? notImplemented,
  };
}

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

/** A `ReadAuthorizer` fake for `*InScope` tests: allows everything except the targets listed in `overrides`, keyed `"<kind>:<path>"`. Records every call so a test can assert exactly what was probed. */
function fakeAuthorizer(
  overrides: Record<string, ReadAuthorizeResult> = {},
): ReadAuthorizer & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    calls,
    async authorize(target) {
      const key = `${target.kind}:${target.path}`;
      calls.push(key);
      return overrides[key] ?? { allowed: true };
    },
  };
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
    identities: { get: async () => buildIdentity() },
    publicUrl: async () => "https://fdrive.example.com",
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    trashPath: null,
    ...overrides,
  };
}

async function aliceScopeContext(indexQueries: Pick<IndexQueries, "rootIdsByName">) {
  const ctx = await resolveScopeContext(indexQueries, ALICE_HOME_SCOPES, null);
  if (ctx === null) {
    throw new Error("expected a scope context");
  }
  return ctx;
}

describe("runSearch", () => {
  it("passes the request storage's Trash path into search", async () => {
    const search = vi.fn(async (input: Parameters<SearchService["search"]>[0]) => ({
      query: input.query,
      sections: { folders: [], files: [], content: [] },
      degraded: false,
      unavailable: false,
      tookMs: 0,
    }));
    const deps = baseDeps({
      searchService: { search },
      trashPathForStorage: () => "/deleted",
    });
    await runSearch(deps, fakePrincipal(), { query: "invoice" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ trashPath: "/deleted" }));
  });

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
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
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
    expect(received?.authorizer).toBeDefined();
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

  it("passes an empty scope list when the caller's identity no longer exists", async () => {
    let received: Parameters<SearchService["search"]>[0] | undefined;
    const deps = baseDeps({
      identities: { get: async () => null },
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
  it("resolves scopes using the principal's own identity id, never any other value", async () => {
    let receivedId: string | undefined;
    const deps = baseDeps({
      identities: {
        get: async (id) => {
          receivedId = id;
          return buildIdentity({ id });
        },
      },
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 0, files: [] }) }),
    });

    await runFindFiles(deps, fakePrincipal(undefined, "identity-of-the-bearer-token"), {});

    expect(receivedId).toBe("identity-of-the-bearer-token");
  });

  it("throws a reason-carrying, path-free error when verified scopes are unavailable", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "indexer_unreachable" }),
      },
    });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(
      /unavailable for this identity \(indexer_unreachable\)/,
    );
  });

  it("throws when the identity no longer exists", async () => {
    const deps = baseDeps({ identities: { get: async () => null } });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(McpToolError);
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

  it("builds a real read authorizer against the principal's own storage, denying a file the storage denies", async () => {
    const file = makeFile({ id: 1, path: "alice/secret.txt", name: "secret.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 1, files: [file] }),
      }),
    });
    const storage = fakeStorage({
      download: async () => {
        throw new StorageError("forbidden", "no");
      },
    });

    const result = await runFindFiles(deps, fakePrincipal(storage), {});

    expect(result.results).toEqual([]);
    expect(result.partial).toBe(true);
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
      findFilesInScope(deps, NARROW_SCOPE_CONTEXT, fakeAuthorizer(), {
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
      fakeAuthorizer(),
      {},
    );

    expect(result.results).toEqual([]);
    expect(result.total_matches).toBe(0);
    expect(result.partial).toBe(true);
  });

  it("excludes exactly the denied file, keeping accessible ones, and reports partial", async () => {
    const allowed = makeFile({ id: 1, path: "alice/keep.txt", name: "keep.txt" });
    const denied = makeFile({ id: 2, path: "alice/secret.txt", name: "secret.txt" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 2, files: [allowed, denied] }),
      }),
    };

    const result = await findFilesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
      {},
    );

    expect(result.results.map((r) => r.path)).toEqual(["/keep.txt"]);
    expect(result.total_matches).toBe(1);
    expect(result.partial).toBe(true);
  });

  it("reports partial when the underlying SQL total exceeds what was fetched", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 500, files: [file] }) }),
    };

    const result = await findFilesInScope(deps, ctx, fakeAuthorizer(), { limit: 1 });

    expect(result.partial).toBe(true);
  });

  it("handles a literal percent sign in a file's virtual path without corrupting the result", async () => {
    const file = makeFile({ id: 1, path: "alice/50%-off.pdf", name: "50%-off.pdf" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ listFiles: async () => ({ total: 1, files: [file] }) }),
    };

    const result = await findFilesInScope(deps, ctx, fakeAuthorizer(), {});

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

    const result = await runListDirectory(baseDeps(), fakePrincipal(storage), { path: "/docs" });

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
      const deps = baseDeps({ trashPathForStorage: () => "/.trash" });

      const result = await runListDirectory(deps, fakePrincipal(fakeStorage({ list })), { path });

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

    const result = await runListDirectory(baseDeps(), fakePrincipal(storage), { limit: 1 });

    expect(result.path).toBe("/");
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("hides the configured Trash entry before pagination", async () => {
    const modifiedAt = new Date();
    const storage = fakeStorage({
      list: async () => [
        { name: ".trash", path: "/.trash", kind: "dir" as const, size: 0, modifiedAt, ext: "" },
        { name: "a", path: "/a", kind: "file" as const, size: 1, modifiedAt, ext: "" },
      ],
    });
    const deps = baseDeps({ trashPathForStorage: () => "/.trash" });

    const result = await runListDirectory(deps, fakePrincipal(storage), { limit: 1 });

    expect(result.entries.map((entry) => entry.name)).toEqual(["a"]);
    expect(result.truncated).toBe(false);
  });

  it.each(["/.trash", "/.trash/deleted.txt", "/docs/../.trash"])(
    "rejects configured Trash path %s before touching storage",
    async (path) => {
      const list = vi.fn(async () => []);
      const storage = fakeStorage({ list });
      const deps = baseDeps({ trashPathForStorage: () => "/.trash" });

      await expect(runListDirectory(deps, fakePrincipal(storage), { path })).rejects.toThrow(
        "configured Trash folder",
      );
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("keeps a Trash-looking entry when Trash is disabled", async () => {
    const modifiedAt = new Date();
    const storage = fakeStorage({
      list: async () => [
        { name: ".trash", path: "/.trash", kind: "dir" as const, size: 0, modifiedAt, ext: "" },
      ],
    });
    const deps = baseDeps({ trashPathForStorage: () => null });

    const result = await runListDirectory(deps, fakePrincipal(storage), {});

    expect(result.entries.map((entry) => entry.name)).toEqual([".trash"]);
  });
});

describe("runReadFileText / readFileTextWithScopes", () => {
  it("throws when no indexer is configured", async () => {
    const deps = baseDeps({ indexerClient: null });
    await expect(runReadFileText(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /FDRIVE_INDEXER_URL/,
    );
  });

  it("normalizes a path that tries to climb above the root before resolving it", async () => {
    const deps = baseDeps({
      indexerClient: {
        extract: async ({ path }) => {
          expect(path).toBe("alice");
          return { text: "root file", status: "ok" };
        },
      },
    });

    const result = await runReadFileText(deps, fakePrincipal(), { path: "/.." });

    expect(result).toMatchObject({ text: "root file" });
  });

  it("throws when extraction fails", async () => {
    const deps = baseDeps({ indexerClient: { extract: async () => null } });
    await expect(runReadFileText(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /failed to extract/,
    );
  });

  it("returns empty text unchanged", async () => {
    const deps = baseDeps({
      indexerClient: { extract: async () => ({ text: "", status: "excluded" }) },
    });

    const result = await runReadFileText(deps, fakePrincipal(), { path: "/a.txt" });

    expect(result).toEqual({
      path: "/a.txt",
      url: "https://fdrive.example.com/view/a.txt",
      status: "excluded",
      text: "",
    });
  });

  it("pages extracted text", async () => {
    const deps = baseDeps({
      indexerClient: {
        extract: async ({ root, path }) => {
          expect(root).toBe("sftpgo");
          expect(path).toBe("alice/a.txt");
          return { text: "hello world", status: "ok" };
        },
      },
    });

    const result = await runReadFileText(deps, fakePrincipal(), {
      path: "/a.txt",
      offset: 0,
      max_chars: 200,
    });

    expect(result).toMatchObject({ status: "ok", text: "hello world", has_more: false });
  });

  it("throws when the path does not resolve within the given scopes", async () => {
    const deps = baseDeps({ indexerClient: { extract: async () => fail("extract") } });

    await expect(
      readFileTextWithScopes(deps, NARROW_SCOPES, fakeAuthorizer(), { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws the same message when the path resolves but a live read check denies it, never distinguishing the two", async () => {
    const deps = baseDeps({ indexerClient: { extract: async () => fail("extract") } });

    await expect(
      readFileTextWithScopes(
        deps,
        ALICE_HOME_SCOPES,
        fakeAuthorizer({ "file:/a.txt": { allowed: false, reason: "denied" } }),
        {
          path: "/a.txt",
        },
      ),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws when the read is unavailable for the caller's identity", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "mismatch" }),
      },
    });
    await expect(runReadFileText(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      McpToolError,
    );
  });

  it("throws when the identity no longer exists", async () => {
    const deps = baseDeps({ identities: { get: async () => null } });
    await expect(runReadFileText(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      McpToolError,
    );
  });
});

describe("runFileInfo / fileInfoInScope", () => {
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

    const result = await runFileInfo(deps, fakePrincipal(), { path: "/a.txt" });

    expect(result.path).toBe("/a.txt");
    expect(result.identical_copies).toEqual(["/copy/a.txt"]);
    expect(result.partial).toBeUndefined();
  });

  it("skips the identical-copies lookup entirely for a file with no hash yet", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt", sha256: null });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ fileByPath: async () => file }),
    });

    const result = await runFileInfo(deps, fakePrincipal(), { path: "/a.txt" });

    expect(result.identical_copies).toEqual([]);
    expect(result.partial).toBeUndefined();
  });

  it("throws when the file is not indexed", async () => {
    const deps = baseDeps({ indexQueries: stubIndexQueries({ fileByPath: async () => null }) });
    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /not indexed/,
    );
  });

  it("throws when the index is unavailable", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });
    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      McpToolError,
    );
  });

  it("throws when the path does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      fileInfoInScope(deps, NARROW_SCOPE_CONTEXT, fakeAuthorizer(), { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws when the resolved root has no id in the index yet", async () => {
    const deps = baseDeps();
    await expect(
      fileInfoInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, fakeAuthorizer(), { path: "/a.txt" }),
    ).rejects.toThrow(/not indexed yet/);
  });

  it("throws when the found file maps to no virtual path in scope", async () => {
    const foreignFile = makeFile({ id: 1, rootId: 999, path: "alice/a.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({ fileByPath: async () => foreignFile }),
    });

    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /not indexed yet/,
    );
  });

  it("throws the exact same message when the file exists but a live read check denies it", async () => {
    const file = makeFile({ id: 1, path: "alice/secret.txt" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({ fileByPath: async () => file }),
    };

    await expect(
      fileInfoInScope(
        deps,
        ctx,
        fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
        { path: "/secret.txt" },
      ),
    ).rejects.toThrow(/not indexed yet/);
  });

  it("excludes exactly the denied identical copy and reports partial", async () => {
    const file = makeFile({ id: 1, path: "alice/a.txt", sha256: "abc" });
    const keepCopy = makeFile({ id: 2, path: "alice/keep.txt", sha256: "abc" });
    const deniedCopy = makeFile({ id: 3, path: "alice/denied.txt", sha256: "abc" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        fileByPath: async () => file,
        filesBySha256: async () => [keepCopy, deniedCopy],
      }),
    };

    const result = await fileInfoInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/denied.txt": { allowed: false, reason: "denied" } }),
      { path: "/a.txt" },
    );

    expect(result.identical_copies).toEqual(["/keep.txt"]);
    expect(result.partial).toBe(true);
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

    const result = await fileInfoInScope(deps, ctx, fakeAuthorizer(), { path: "/a.txt" });

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
      findDuplicatesInScope(deps, NARROW_SCOPE_CONTEXT, fakeAuthorizer(), {
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

    const result = await findDuplicatesInScope(deps, ctx, fakeAuthorizer(), {});

    expect(result.groups).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("drops a group down to fewer than two authorized copies entirely, and reports partial", async () => {
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
              { rootId: 1, path: "alice/a.txt" },
              { rootId: 1, path: "alice/secret.txt" },
            ],
          },
        ],
      }),
    };

    const result = await findDuplicatesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
      {},
    );

    expect(result.groups).toEqual([]);
    expect(result.total_groups).toBe(0);
    expect(result.partial).toBe(true);
  });

  it("keeps a group with three copies when exactly one is denied, recomputing wasted bytes from survivors only", async () => {
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
              { rootId: 1, path: "alice/secret.txt" },
            ],
          },
        ],
      }),
    };

    const result = await findDuplicatesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
      {},
    );

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

    const result = await findDuplicatesInScope(deps, ctx, fakeAuthorizer(), {});

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
      similarFilesInScope(deps, NARROW_SCOPE_CONTEXT, fakeAuthorizer(), { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("throws when the resolved root has no id in the index yet", async () => {
    const deps = baseDeps();
    await expect(
      similarFilesInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, fakeAuthorizer(), {
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

    await expect(
      similarFilesInScope(deps, ctx, fakeAuthorizer(), { path: "/target.md" }),
    ).rejects.toThrow(/not indexed/);
  });

  it("throws the same message when the source file itself fails a live read check", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => fail("similar"),
      }),
    };

    await expect(
      similarFilesInScope(
        deps,
        ctx,
        fakeAuthorizer({ "file:/target.md": { allowed: false, reason: "denied" } }),
        { path: "/target.md" },
      ),
    ).rejects.toThrow(/not indexed/);
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

  it("excludes exactly the denied similar candidate, keeping the rest, and reports partial", async () => {
    const target = makeFile({ id: 1, path: "alice/target.md" });
    const keep = makeFile({ id: 2, path: "alice/keep.md" });
    const denied = makeFile({ id: 3, path: "alice/secret.md" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        fileByPath: async () => target,
        similar: async () => [
          { fileId: 2, similarity: 0.9 },
          { fileId: 3, similarity: 0.8 },
        ],
        filesByIds: async () => [keep, denied],
      }),
    };

    const result = await similarFilesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.md": { allowed: false, reason: "denied" } }),
      { path: "/target.md" },
    );

    expect(result.results.map((r) => r.path)).toEqual(["/keep.md"]);
    expect(result.partial).toBe(true);
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
      folderOverviewInScope(deps, NARROW_SCOPE_CONTEXT, fakeAuthorizer(), {
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

  it("excludes exactly the denied file's bytes from every aggregate, and reports truncated", async () => {
    const keep = makeFile({ id: 1, path: "alice/docs/keep.pdf", ext: ".pdf", size: 100 });
    const denied = makeFile({ id: 2, path: "alice/docs/secret.pdf", ext: ".pdf", size: 900 });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 2, files: [keep, denied] }),
      }),
    };

    const result = await folderOverviewInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/docs/secret.pdf": { allowed: false, reason: "denied" } }),
      {},
    );

    expect(result.total_files).toBe(1);
    expect(result.total_bytes).toBe(100);
    expect(result.folders.find((f) => f.path === "/docs")).toMatchObject({ files: 1, bytes: 100 });
    expect(result.truncated).toBe(true);
  });
});

describe("runIndexStats / indexStatsInScope", () => {
  it("returns aggregate stats derived only from authorized files", async () => {
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
      writesEnabled: true,
    });

    const result = await runIndexStats(deps, fakePrincipal());

    expect(result).toEqual({
      files_tracked: 2,
      by_text_status: [{ status: "done", files: 2, bytes: 150 }],
      chunks: 5,
      chunks_embedded: 5,
      writes_enabled: true,
    });
  });

  it("excludes a denied file from every count and reports partial", async () => {
    const keep = makeFile({ id: 1, path: "alice/a.txt", size: 100, textStatus: "done" });
    const denied = makeFile({ id: 2, path: "alice/secret.txt", size: 900, textStatus: "done" });
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 2, files: [keep, denied] }),
        statsForFileIds: async (ids) => {
          expect(ids).toEqual([1]);
          return { chunks: 1, chunksEmbedded: 1 };
        },
      }),
    };

    const result = await indexStatsInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
    );

    expect(result.files_tracked).toBe(1);
    expect(result.by_text_status).toEqual([{ status: "done", files: 1, bytes: 100 }]);
    expect(result.chunks).toBe(1);
    expect(result.partial).toBe(true);
  });
});

describe("runCreateFolder", () => {
  it("throws when writes are disabled", async () => {
    const deps = baseDeps({ writesEnabled: false });
    await expect(runCreateFolder(deps, fakePrincipal(), { path: "/new" })).rejects.toThrow(
      /FDRIVE_MCP_WRITES/,
    );
  });

  it("creates a folder when writes are enabled", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({ writesEnabled: true });

    const result = await runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), {
      path: "/new",
    });

    expect(mkdir).toHaveBeenCalledWith("/new", { parents: true });
    expect(result).toEqual({ created: "/new", url: "https://fdrive.example.com/files/new" });
  });

  it.each(["/docs/../new", "//new", "/./new", "/new/", "/new/sub/.."])(
    "creates the folder at the admitted path for the unnormalized %s",
    async (path) => {
      const mkdir = vi.fn(async () => undefined);
      const deps = baseDeps({ writesEnabled: true });

      const result = await runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), { path });

      // The provider forwards this string verbatim, so it must be the exact
      // path the scope admission was decided on, not the caller's argument.
      expect(mkdir).toHaveBeenCalledWith("/new", { parents: true });
      expect(result).toEqual({ created: "/new", url: "https://fdrive.example.com/files/new" });
    },
  );

  it("leaves characters normalization must not touch byte-identical", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({ writesEnabled: true });

    const result = await runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), {
      path: "/a b/50%-off & #1..2",
    });

    expect(mkdir).toHaveBeenCalledWith("/a b/50%-off & #1..2", { parents: true });
    expect(result.created).toBe("/a b/50%-off & #1..2");
  });

  it("creates through the override that exposes a shadowed location", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [
            { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
            { rootName: "sftpgo", fsPrefix: "/alice/docs", virtualPrefix: "/other" },
          ],
        }),
      },
    });

    const result = await runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), {
      path: "/docs/new",
    });

    // "/alice/docs" is reachable only as "/other" for this identity, the same
    // virtual path every read tool reports for that location.
    expect(mkdir).toHaveBeenCalledWith("/other/new", { parents: true });
    expect(result.created).toBe("/other/new");
  });

  it.each(["/.trash", "/.trash/deleted.txt", "/docs/../.trash"])(
    "refuses the configured Trash path %s before touching storage",
    async (path) => {
      const mkdir = vi.fn(async () => undefined);
      const deps = baseDeps({ writesEnabled: true, trashPathForStorage: () => "/.trash" });

      await expect(
        runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), { path }),
      ).rejects.toThrow("path is outside this identity's scope");
      expect(mkdir).not.toHaveBeenCalled();
    },
  );

  it("refuses a folder that climbs out of the verified scope without touching storage", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "sftpgo", fsPrefix: "/alice/docs", virtualPrefix: "/docs" }],
        }),
      },
    });

    await expect(
      runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), {
        path: "/docs/../private/new",
      }),
    ).rejects.toThrow("path is outside this identity's scope");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("refuses a folder outside the verified scope without touching storage", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "sftpgo", fsPrefix: "/alice/docs", virtualPrefix: "/docs" }],
        }),
      },
    });

    await expect(
      runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), { path: "/private/new" }),
    ).rejects.toThrow("path is outside this identity's scope");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("refuses a folder when verified scopes are unavailable", async () => {
    const mkdir = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_connection" }),
      },
    });

    await expect(
      runCreateFolder(deps, fakePrincipal(fakeStorage({ mkdir })), { path: "/new" }),
    ).rejects.toThrow(McpToolError);
    expect(mkdir).not.toHaveBeenCalled();
  });
});

describe("runMovePath", () => {
  it("refuses occupied destinations without moving", async () => {
    const move = vi.fn();
    const storage = fakeStorage({
      move,
      statFile: async () => ({ size: 12, modifiedAt: null, contentType: null }),
    });
    await expect(
      runMovePath(baseDeps({ writesEnabled: true }), fakePrincipal(storage), {
        src: "/a",
        dst: "/b",
      }),
    ).rejects.toThrow("already exists");
    expect(move).not.toHaveBeenCalled();
  });

  it("reports completed moves with warnings when metadata and audit persistence fail", async () => {
    const move = vi.fn();
    const deps = baseDeps({
      writesEnabled: true,
      onMutation: async () => {
        throw new Error("metadata unavailable");
      },
      indexQueries: stubIndexQueries({
        recordMove: async () => {
          throw new Error("database unavailable");
        },
      }),
    });
    const result = await runMovePath(deps, fakePrincipal(fakeStorage({ move })), {
      src: "/a",
      dst: "/b",
    });
    expect(result).toMatchObject({
      moved: "/a",
      to: "/b",
      warnings: [expect.stringContaining("metadata"), expect.stringContaining("history")],
    });
    expect(move).toHaveBeenCalledOnce();
  });

  it("does not mutate or record history for a same-path move", async () => {
    const move = vi.fn();
    const recordMove = vi.fn();
    await runMovePath(
      baseDeps({ writesEnabled: true, indexQueries: stubIndexQueries({ recordMove }) }),
      fakePrincipal(fakeStorage({ move })),
      { src: "/a", dst: "/a" },
    );
    expect(move).not.toHaveBeenCalled();
    expect(recordMove).not.toHaveBeenCalled();
  });

  it("uses storage kind for a dotted directory and runs the mutation hook", async () => {
    const onMutation = vi.fn();
    const storage = fakeStorage({
      move: async () => {},
      stat: async () => ({ kind: "dir", size: 0, modifiedAt: null, contentType: null }),
    });
    const result = await runMovePath(
      baseDeps({
        writesEnabled: true,
        onMutation,
        indexQueries: stubIndexQueries({ recordMove: async () => {} }),
      }),
      fakePrincipal(storage),
      { src: "/a", dst: "/archive.2026" },
    );
    expect(result.url).toBe("https://fdrive.example.com/files/archive.2026");
    expect(onMutation).toHaveBeenCalledWith(expect.anything(), {
      kind: "move",
      path: "/a",
      target: "/archive.2026",
      isDir: true,
    });
  });
  it("throws when writes are disabled", async () => {
    const deps = baseDeps({ writesEnabled: false });
    await expect(
      runMovePath(deps, fakePrincipal(), { src: "/a.txt", dst: "/b.txt" }),
    ).rejects.toThrow(/FDRIVE_MCP_WRITES/);
  });

  it("moves and records the move when the index is available", async () => {
    const move = vi.fn(async () => undefined);
    const recordMove = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      indexQueries: stubIndexQueries({ recordMove }),
    });

    const result = await runMovePath(deps, fakePrincipal(fakeStorage({ move })), {
      src: "/a.txt",
      dst: "/b.txt",
    });

    expect(move).toHaveBeenCalledWith("/a.txt", "/b.txt", { overwrite: false });
    expect(recordMove).toHaveBeenCalledWith({
      rootId: 1,
      src: "alice/a.txt",
      dst: "alice/b.txt",
      actor: "mcp",
    });
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
    const recordMove = vi.fn(async () => undefined);
    const deps = baseDeps({ writesEnabled: true, indexQueries: stubIndexQueries({ recordMove }) });

    const result = await runMovePath(deps, fakePrincipal(fakeStorage({ move })), { src, dst });

    // The provider forwards both strings verbatim, so both must be the exact
    // paths the scope admission was decided on.
    expect(move).toHaveBeenCalledWith("/a.txt", "/b.txt", { overwrite: false });
    expect(recordMove).toHaveBeenCalledWith({
      rootId: 1,
      src: "alice/a.txt",
      dst: "alice/b.txt",
      actor: "mcp",
    });
    expect(result).toEqual({
      moved: "/a.txt",
      to: "/b.txt",
      url: "https://fdrive.example.com/view/b.txt",
    });
  });

  it.each(["/.trash", "/.trash/deleted.txt", "/docs/../.trash"])(
    "refuses a src in the configured Trash path %s before touching storage",
    async (src) => {
      const move = vi.fn(async () => undefined);
      const deps = baseDeps({ writesEnabled: true, trashPathForStorage: () => "/.trash" });

      await expect(
        runMovePath(deps, fakePrincipal(fakeStorage({ move })), { src, dst: "/b.txt" }),
      ).rejects.toThrow("src is outside this identity's scope");
      expect(move).not.toHaveBeenCalled();
    },
  );

  it.each(["/.trash", "/.trash/deleted.txt", "/docs/../.trash"])(
    "refuses a dst in the configured Trash path %s before touching storage",
    async (dst) => {
      const move = vi.fn(async () => undefined);
      const deps = baseDeps({ writesEnabled: true, trashPathForStorage: () => "/.trash" });

      await expect(
        runMovePath(deps, fakePrincipal(fakeStorage({ move })), { src: "/a.txt", dst }),
      ).rejects.toThrow("dst is outside this identity's scope");
      expect(move).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["src", { src: "/docs/../private/a.txt", dst: "/docs/b.txt" }],
    ["dst", { src: "/docs/a.txt", dst: "/docs/../private/b.txt" }],
  ])("refuses a move whose %s climbs out of the verified scope", async (label, args) => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "sftpgo", fsPrefix: "/alice/docs", virtualPrefix: "/docs" }],
        }),
      },
    });

    await expect(runMovePath(deps, fakePrincipal(fakeStorage({ move })), args)).rejects.toThrow(
      `${label} is outside this identity's scope`,
    );
    expect(move).not.toHaveBeenCalled();
  });

  it("uses storage kind for an extensionless file in the returned url", async () => {
    const deps = baseDeps({
      writesEnabled: true,
      indexQueries: stubIndexQueries({ recordMove: async () => undefined }),
    });

    const result = await runMovePath(
      deps,
      fakePrincipal(fakeStorage({ move: async () => undefined })),
      {
        src: "/a",
        dst: "/folder",
      },
    );

    expect(result.url).toBe("https://fdrive.example.com/view/folder");
  });

  it("refuses the move without touching storage when verified scopes are unavailable", async () => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });

    await expect(
      runMovePath(deps, fakePrincipal(fakeStorage({ move })), { src: "/a.txt", dst: "/b.txt" }),
    ).rejects.toThrow(McpToolError);
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses the move without touching storage when the caller's identity no longer exists", async () => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({ writesEnabled: true, identities: { get: async () => null } });

    await expect(
      runMovePath(deps, fakePrincipal(fakeStorage({ move })), { src: "/a.txt", dst: "/b.txt" }),
    ).rejects.toThrow(McpToolError);
    expect(move).not.toHaveBeenCalled();
  });

  it.each([
    ["src", { src: "/elsewhere/a.txt", dst: "/docs/b.txt" }],
    ["dst", { src: "/docs/a.txt", dst: "/elsewhere/b.txt" }],
  ])("refuses a move whose %s is outside the verified scope", async (label, args) => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "sftpgo", fsPrefix: "/alice/docs", virtualPrefix: "/docs" }],
        }),
      },
    });

    await expect(runMovePath(deps, fakePrincipal(fakeStorage({ move })), args)).rejects.toThrow(
      `${label} is outside this identity's scope`,
    );
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses a move into the trash", async () => {
    const move = vi.fn(async () => undefined);
    const deps = baseDeps({ writesEnabled: true, trashPath: "/Trash" });

    await expect(
      runMovePath(deps, fakePrincipal(fakeStorage({ move })), {
        src: "/a.txt",
        dst: "/Trash/a.txt",
      }),
    ).rejects.toThrow("dst is outside this identity's scope");
    expect(move).not.toHaveBeenCalled();
  });

  it("skips recording the move when verified scopes land on no indexed root", async () => {
    const deps = baseDeps({
      writesEnabled: true,
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "unindexed-root", fsPrefix: "/alice", virtualPrefix: "/" }],
        }),
      },
    });

    const result = await runMovePath(
      deps,
      fakePrincipal(fakeStorage({ move: async () => undefined })),
      { src: "/a.txt", dst: "/b.txt" },
    );

    expect(result.moved).toBe("/a.txt");
  });
});

describe("recordMoveIfInScope", () => {
  it("is a no-op when src and dst resolve to different roots", async () => {
    const deps = baseDeps();
    const twoRootScopes: ScopeContext = {
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/a" },
        { rootName: "photos", fsPrefix: "/alice", virtualPrefix: "/b" },
      ],
      scopePrefixes: [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 2, fsPrefix: "/alice" },
      ],
      rootNameById: new Map([
        [1, "sftpgo"],
        [2, "photos"],
      ]),
      rootIdByName: new Map([
        ["sftpgo", 1],
        ["photos", 2],
      ]),
      trashPath: null,
    };

    await expect(
      recordMoveIfInScope(deps, twoRootScopes, { src: "/a/x.txt", dst: "/b/y.txt" }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the destination's root has no id in the index yet", async () => {
    const deps = baseDeps();

    await expect(
      recordMoveIfInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, { src: "/a.txt", dst: "/b.txt" }),
    ).resolves.toBeUndefined();
  });
});

describe("runRecentMoves / recentMovesInScope", () => {
  it("returns an empty list when the index is unavailable", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      },
    });
    expect(await runRecentMoves(deps, fakePrincipal(), {})).toEqual({ moves: [] });
  });

  it("returns an empty list when the caller's identity no longer exists", async () => {
    const deps = baseDeps({ identities: { get: async () => null } });
    expect(await runRecentMoves(deps, fakePrincipal(), {})).toEqual({ moves: [] });
  });

  it("returns an empty list when verified scopes land on no indexed root", async () => {
    const deps = baseDeps({
      scopeResolver: {
        verifiedIndexScopes: async () => ({
          available: true,
          scopes: [{ rootName: "unindexed-root", fsPrefix: "/alice", virtualPrefix: "/" }],
        }),
      },
    });
    expect(await runRecentMoves(deps, fakePrincipal(), {})).toEqual({ moves: [] });
  });

  it("maps recorded moves to virtual paths", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        recentMoves: async () => [
          { at, rootId: 1, src: "alice/a.txt", dst: "alice/b.txt", actor: "mcp" },
        ],
      }),
    });

    const result = await runRecentMoves(deps, fakePrincipal(), {});

    expect(result).toEqual({ moves: [{ at: at.toISOString(), src: "/a.txt", dst: "/b.txt" }] });
  });

  it("skips a move whose src or dst falls outside the scope", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        recentMoves: async () => [
          { at, rootId: 1, src: "bob/a.txt", dst: "alice/b.txt", actor: "mcp" },
        ],
      }),
    });

    const result = await runRecentMoves(deps, fakePrincipal(), {});

    expect(result).toEqual({ moves: [], partial: true });
  });

  it("skips a move with a null src or dst", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        recentMoves: async () => [{ at, rootId: 1, src: null, dst: "alice/b.txt", actor: "mcp" }],
      }),
    });

    const result = await runRecentMoves(deps, fakePrincipal(), {});

    expect(result).toEqual({ moves: [], partial: true });
  });

  it("hides a move whose destination fails a live read check, never disclosing the source either", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        recentMoves: async () => [
          { at, rootId: 1, src: "alice/a.txt", dst: "alice/secret.txt", actor: "mcp" },
        ],
      }),
    };

    const result = await recentMovesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
      {},
    );

    expect(result.moves).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("authorizes an extensionless destination as a directory, not a file", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        recentMoves: async () => [
          { at, rootId: 1, src: "alice/old-folder", dst: "alice/new-folder", actor: "mcp" },
        ],
      }),
    };
    const authorizer = fakeAuthorizer();

    const result = await recentMovesInScope(deps, ctx, authorizer, {});

    expect(result.moves).toEqual([
      { at: at.toISOString(), src: "/old-folder", dst: "/new-folder" },
    ]);
    expect(authorizer.calls).toEqual(["dir:/new-folder"]);
  });

  it("excludes exactly the denied move while keeping an allowed one, and reports partial", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const ctx = await aliceScopeContext(stubIndexQueries());
    const deps = {
      ...baseDeps(),
      indexQueries: stubIndexQueries({
        recentMoves: async () => [
          { at, rootId: 1, src: "alice/a.txt", dst: "alice/keep.txt", actor: "mcp" },
          { at, rootId: 1, src: "alice/b.txt", dst: "alice/secret.txt", actor: "mcp" },
        ],
      }),
    };

    const result = await recentMovesInScope(
      deps,
      ctx,
      fakeAuthorizer({ "file:/secret.txt": { allowed: false, reason: "denied" } }),
      {},
    );

    expect(result.moves).toEqual([{ at: at.toISOString(), src: "/a.txt", dst: "/keep.txt" }]);
    expect(result.partial).toBe(true);
  });
});
