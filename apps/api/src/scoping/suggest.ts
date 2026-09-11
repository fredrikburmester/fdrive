import type { IdentityScopeSuggestionsResponse, ScopeMappingSuggestion } from "@fdrive/contracts";
import { MAX_SCOPE_SUGGESTIONS } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Identity, IndexQueries } from "@fdrive/db";
import type { IndexRootConfig } from "../config.ts";
import type { IndexerClient } from "../system/indexer-client.ts";
import { verifyMountDirectory } from "./directory-verify.ts";
import type { ScopeResolver } from "./resolver.ts";
import type { DirectoryEntryLite } from "./types.ts";

/** How many indexed directories to consider per mount before confirming each against the indexer. */
const CANDIDATE_LIMIT = 20;

export interface CreateScopeSuggesterDeps {
  readonly resolver: Pick<ScopeResolver, "status">;
  readonly storageForIdentity: (identity: Identity) => Promise<StorageProvider>;
  readonly indexer: Pick<IndexerClient, "directory">;
  readonly indexQueries: Pick<IndexQueries, "rootIdsByName" | "directoriesWithFiles">;
  readonly indexRoots: readonly IndexRootConfig[] | null;
}

export interface ScopeSuggester {
  /** Confirmed candidate locations for each of the identity's unmapped directory mounts. */
  suggest(identity: Identity): Promise<IdentityScopeSuggestionsResponse>;
}

/** The `Scope`-style physical prefix for a root-relative index directory ("" is the root). */
function fsPrefixFor(directory: string): string {
  return directory === "" ? "/" : `/${directory}`;
}

/**
 * Proposes where an unmapped SFTPGo virtual folder physically lives
 * (`docs/SCOPING.md`): the mount is listed over SFTP,
 * the index is asked for directories whose direct files carry every file
 * name seen there, and each candidate is then confirmed with the same
 * directory comparison verification uses. A suggestion grants nothing; the
 * administrator turns it into a mapping by saving it. A mount with no
 * top-level files has nothing to match on and gets no suggestion.
 */
export function createScopeSuggester(deps: CreateScopeSuggesterDeps): ScopeSuggester {
  async function candidatesFor(
    entries: readonly DirectoryEntryLite[],
    rootNameById: ReadonlyMap<number, string>,
  ): Promise<ScopeMappingSuggestion[]> {
    const fileNames = entries.filter((entry) => entry.kind === "file").map((entry) => entry.name);
    if (fileNames.length === 0) return [];

    const rows = await deps.indexQueries.directoriesWithFiles(fileNames, CANDIDATE_LIMIT);
    const suggestions: ScopeMappingSuggestion[] = [];
    for (const row of rows) {
      if (suggestions.length >= MAX_SCOPE_SUGGESTIONS) break;
      const rootName = rootNameById.get(row.rootId);
      if (rootName === undefined) continue;
      const fsPrefix = fsPrefixFor(row.directory);
      const listing = await deps.indexer.directory(rootName, fsPrefix);
      if (!listing.ok) continue;
      const verified = verifyMountDirectory({
        sftpEntries: entries,
        indexEntries: listing.data.items,
        indexOverflow: listing.data.overflow,
        excludedNames: new Set(),
      });
      if (verified.ok) suggestions.push({ rootName, fsPrefix });
    }
    return suggestions;
  }

  return {
    async suggest(identity) {
      const status = await deps.resolver.status(identity, true);
      const mounts = status.unmappedMounts.filter((mount) => mount.kind === "dir");
      if (mounts.length === 0) return { mounts: [] };

      const indexRootNames = new Set((deps.indexRoots ?? []).map((root) => root.name));
      const rootNameById = new Map<number, string>();
      for (const [name, id] of Object.entries(await deps.indexQueries.rootIdsByName())) {
        if (indexRootNames.has(name)) rootNameById.set(id, name);
      }

      let storage: StorageProvider;
      try {
        storage = await deps.storageForIdentity(identity);
      } catch {
        return {
          mounts: mounts.map((mount) => ({ virtualPath: mount.virtualPath, suggestions: [] })),
        };
      }

      const result: IdentityScopeSuggestionsResponse["mounts"] = [];
      for (const mount of mounts) {
        let entries: DirectoryEntryLite[] = [];
        try {
          const listed = await storage.list(mount.virtualPath);
          entries = listed.map((entry) => ({ name: entry.name, kind: entry.kind }));
        } catch {
          // An unlistable mount simply has no suggestions.
        }
        result.push({
          virtualPath: mount.virtualPath,
          suggestions: entries.length === 0 ? [] : await candidatesFor(entries, rootNameById),
        });
      }
      return { mounts: result };
    },
  };
}
