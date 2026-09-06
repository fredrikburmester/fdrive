import type { Scope, StorageProvider } from "@fdrive/core";
import { parseHomeTemplate } from "@fdrive/core";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { SearchService } from "../search/service.js";
import {
  fileInfoInScope,
  findDuplicatesInScope,
  findFilesInScope,
  folderOverviewInScope,
  McpToolError,
  readFileTextWithScopes,
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

const HOME_TEMPLATE = parseHomeTemplate("sftpgo:/{username}");

/** A scope covering only "/only", used to exercise the "outside this identity's scope" branches directly. */
const NARROW_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/only" },
];

const NARROW_SCOPE_CONTEXT: ScopeContext = {
  scopes: NARROW_SCOPES,
  scopePrefixes: [{ rootId: 1, fsPrefix: "/alice" }],
  rootNameById: new Map([[1, "sftpgo"]]),
  rootIdByName: new Map([["sftpgo", 1]]),
};

/** Like `NARROW_SCOPE_CONTEXT`, but with a root name that has no id yet, to exercise the "root not indexed" branch. */
const UNINDEXED_ROOT_SCOPE_CONTEXT: ScopeContext = {
  scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
  scopePrefixes: [],
  rootNameById: new Map(),
  rootIdByName: new Map(),
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

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

function fakeStorage(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    list: overrides.list ?? notImplemented,
    statFile: overrides.statFile ?? notImplemented,
    download: overrides.download ?? notImplemented,
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

function fakePrincipal(storage: StorageProvider = fakeStorage()): Principal {
  return {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage,
    isAdmin: false,
  };
}

function fakeSearchService(overrides: Partial<SearchService> = {}): SearchService {
  return {
    search: overrides.search ?? (async () => fail("search")),
    status: overrides.status ?? (() => ({ available: true, semantic: true })),
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
    homeTemplate: HOME_TEMPLATE,
    indexRootNames: new Set(["sftpgo"]),
    searchService: fakeSearchService(),
    fdrivePublicUrl: "https://fdrive.example.com",
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
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

    expect(result).toEqual({ query: "x", results: [], available: false });
  });
});

describe("runFindFiles", () => {
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

  it("throws when the index is unavailable", async () => {
    const deps = baseDeps({ indexRootNames: new Set() });
    await expect(runFindFiles(deps, fakePrincipal(), {})).rejects.toThrow(McpToolError);
  });

  it("throws when path_prefix does not resolve within the scope", async () => {
    const deps = baseDeps();
    await expect(
      findFilesInScope(deps, NARROW_SCOPE_CONTEXT, { path_prefix: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });

  it("filters out a result file that maps to no virtual path in scope", async () => {
    const outOfScope = makeFile({ id: 1, rootId: 999, path: "bob/a.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 1, files: [outOfScope] }),
      }),
    });

    const result = await runFindFiles(deps, fakePrincipal(), {});

    expect(result.results).toEqual([]);
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

    const result = await runListDirectory(fakePrincipal(storage), { path: "/docs" });

    expect(result.path).toBe("/docs");
    expect(result.entries).toEqual([
      {
        name: "a.txt",
        type: "file",
        path: "/docs/a.txt",
        size_bytes: 10,
        modified: modifiedAt.toISOString(),
        url: "/view/docs/a.txt",
      },
      {
        name: "sub",
        type: "dir",
        path: "/docs/sub",
        size_bytes: null,
        modified: modifiedAt.toISOString(),
        url: "/files/docs/sub",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("defaults to the root and truncates past the limit", async () => {
    const modifiedAt = new Date();
    const storage = fakeStorage({
      list: async () => [
        { name: "a", path: "/a", kind: "file" as const, size: 1, modifiedAt, ext: "" },
        { name: "b", path: "/b", kind: "file" as const, size: 1, modifiedAt, ext: "" },
      ],
    });

    const result = await runListDirectory(fakePrincipal(storage), { limit: 1 });

    expect(result.path).toBe("/");
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe("runReadFileText", () => {
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
      readFileTextWithScopes(deps, NARROW_SCOPES, { path: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });
});

describe("runFileInfo", () => {
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
  });

  it("throws when the file is not indexed", async () => {
    const deps = baseDeps({ indexQueries: stubIndexQueries({ fileByPath: async () => null }) });
    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /not indexed/,
    );
  });

  it("throws when the index is unavailable", async () => {
    const deps = baseDeps({ indexRootNames: new Set() });
    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      McpToolError,
    );
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

    await expect(runFileInfo(deps, fakePrincipal(), { path: "/a.txt" })).rejects.toThrow(
      /not indexed yet/,
    );
  });
});

describe("runFindDuplicates", () => {
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
      findDuplicatesInScope(deps, NARROW_SCOPE_CONTEXT, { path_prefix: "/elsewhere" }),
    ).rejects.toThrow(/outside this identity's scope/);
  });
});

describe("runSimilarFiles", () => {
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
      similarFilesInScope(deps, UNINDEXED_ROOT_SCOPE_CONTEXT, { path: "/target.md" }),
    ).rejects.toThrow(/not indexed yet/);
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

describe("runFolderOverview", () => {
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
      folderOverviewInScope(deps, NARROW_SCOPE_CONTEXT, { path_prefix: "/elsewhere" }),
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

  it("skips a file that maps to no virtual path in scope", async () => {
    const outOfScope = makeFile({ id: 1, rootId: 999, path: "bob/a.txt" });
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        listFiles: async () => ({ total: 1, files: [outOfScope] }),
      }),
    });

    const result = await runFolderOverview(deps, fakePrincipal(), {});

    expect(result.folders).toEqual([]);
    // Bytes are still summed from every loaded file, scoped or not.
    expect(result.total_bytes).toBe(outOfScope.size);
  });
});

describe("runIndexStats", () => {
  it("returns aggregate stats for the scope", async () => {
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        stats: async () => ({
          filesTracked: 10,
          byTextStatus: [{ status: "done", files: 10, bytes: 1000 }],
          chunks: 5,
          chunksEmbedded: 5,
        }),
      }),
      writesEnabled: true,
    });

    const result = await runIndexStats(deps, fakePrincipal());

    expect(result).toEqual({
      files_tracked: 10,
      by_text_status: [{ status: "done", files: 10, bytes: 1000 }],
      chunks: 5,
      chunks_embedded: 5,
      writes_enabled: true,
    });
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
});

describe("runMovePath", () => {
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

    expect(move).toHaveBeenCalledWith("/a.txt", "/b.txt");
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

  it("treats an extensionless destination as a folder in the returned url", async () => {
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

    expect(result.url).toBe("https://fdrive.example.com/files/folder");
  });

  it("skips recording the move when the index is unavailable", async () => {
    const deps = baseDeps({
      writesEnabled: true,
      indexRootNames: new Set(),
    });

    const result = await runMovePath(
      deps,
      fakePrincipal(fakeStorage({ move: async () => undefined })),
      {
        src: "/a.txt",
        dst: "/b.txt",
      },
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

describe("runRecentMoves", () => {
  it("returns an empty list when the index is unavailable", async () => {
    const deps = baseDeps({ indexRootNames: new Set() });
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

    expect(result).toEqual({ moves: [] });
  });

  it("skips a move with a null src or dst", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const deps = baseDeps({
      indexQueries: stubIndexQueries({
        recentMoves: async () => [{ at, rootId: 1, src: null, dst: "alice/b.txt", actor: "mcp" }],
      }),
    });

    const result = await runRecentMoves(deps, fakePrincipal(), {});

    expect(result).toEqual({ moves: [] });
  });
});
