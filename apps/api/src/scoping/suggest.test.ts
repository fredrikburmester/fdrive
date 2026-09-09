import type { IndexerDirectoryResponse } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import type { IndexRootConfig } from "../config.ts";
import type { ScopeResolver } from "./resolver.ts";
import { createScopeSuggester } from "./suggest.ts";
import {
  buildIdentity,
  fakeIndexerDirectory,
  fakeStorageProvider,
  fileEntry,
} from "./test-fixtures/index.ts";
import type { ScopeStatus } from "./types.ts";

const INDEX_ROOTS: IndexRootConfig[] = [
  { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/index-data" },
];

function statusWithMounts(mounts: ScopeStatus["unmappedMounts"]): Pick<ScopeResolver, "status"> {
  return {
    status: async () => ({
      status: "unavailable",
      reason: "unmapped_mount",
      usesOverride: false,
      virtualPrefixes: ["/"],
      unmappedMounts: mounts,
      unverifiedPrefixes: [],
      unindexedPrefixes: [],
      warning: "w",
      isAdmin: true,
      configuredRoots: ["sftpgo"],
      mappings: [],
      overrides: [],
      adoptedMappings: [],
    }),
  };
}

const sharedListing: IndexerDirectoryResponse = {
  items: [
    { name: "team.txt", kind: "file" },
    { name: "docs", kind: "dir" },
  ],
  overflow: false,
};

describe("createScopeSuggester", () => {
  it("confirms index candidates against the mount's live listing, in order", async () => {
    const directoriesWithFiles = vi.fn(async () => [
      { rootId: 1, directory: "alice/copy" }, // has team.txt but not the docs dir: rejected
      { rootId: 1, directory: "_folders/shared" },
      { rootId: 2, directory: "mirror" }, // root 2 is not an index root: skipped
      { rootId: 1, directory: "" }, // unreachable listing: skipped
    ]);
    const suggester = createScopeSuggester({
      resolver: statusWithMounts([{ virtualPath: "/shared", kind: "dir" }]),
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async () => [fileEntry("team.txt"), fileEntry("docs", "dir")],
        }),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/_folders/shared", sharedListing],
          ["sftpgo:/alice/copy", { items: [{ name: "team.txt", kind: "file" }], overflow: false }],
        ]),
      ),
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1, other: 2 }),
        directoriesWithFiles,
      },
      indexRoots: INDEX_ROOTS,
    });

    expect(await suggester.suggest(buildIdentity())).toEqual({
      mounts: [
        {
          virtualPath: "/shared",
          suggestions: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
        },
      ],
    });
    expect(directoriesWithFiles).toHaveBeenCalledWith(["team.txt"], 20);
  });

  it("offers nothing for a mount with no top-level files, an unlistable mount, or a file mount", async () => {
    const directoriesWithFiles = vi.fn(async () => []);
    const suggester = createScopeSuggester({
      resolver: statusWithMounts([
        { virtualPath: "/empty", kind: "dir" },
        { virtualPath: "/broken", kind: "dir" },
        { virtualPath: "/note.txt", kind: "file" },
      ]),
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) => {
            if (path === "/broken") throw new Error("denied");
            return [fileEntry("sub", "dir")];
          },
        }),
      indexer: fakeIndexerDirectory(new Map()),
      indexQueries: { rootIdsByName: async () => ({ sftpgo: 1 }), directoriesWithFiles },
      indexRoots: INDEX_ROOTS,
    });
    expect(await suggester.suggest(buildIdentity())).toEqual({
      mounts: [
        { virtualPath: "/empty", suggestions: [] },
        { virtualPath: "/broken", suggestions: [] },
      ],
    });
    expect(directoriesWithFiles).not.toHaveBeenCalled();
  });

  it("returns an empty list when there is no unmapped mount, without touching storage", async () => {
    const storageForIdentity = vi.fn(async () => fakeStorageProvider());
    const suggester = createScopeSuggester({
      resolver: statusWithMounts([]),
      storageForIdentity,
      indexer: fakeIndexerDirectory(new Map()),
      indexQueries: { rootIdsByName: async () => ({}), directoriesWithFiles: async () => [] },
      indexRoots: INDEX_ROOTS,
    });
    expect(await suggester.suggest(buildIdentity())).toEqual({ mounts: [] });
    expect(storageForIdentity).not.toHaveBeenCalled();
  });

  it("offers nothing for every mount when the identity's storage cannot be opened", async () => {
    const suggester = createScopeSuggester({
      resolver: statusWithMounts([{ virtualPath: "/shared", kind: "dir" }]),
      storageForIdentity: async () => {
        throw new Error("no client");
      },
      indexer: fakeIndexerDirectory(new Map()),
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        directoriesWithFiles: async () => [],
      },
      indexRoots: INDEX_ROOTS,
    });
    expect(await suggester.suggest(buildIdentity())).toEqual({
      mounts: [{ virtualPath: "/shared", suggestions: [] }],
    });
  });
});
