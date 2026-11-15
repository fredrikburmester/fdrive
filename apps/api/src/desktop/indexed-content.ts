import { type ContentStamp, toFsPath } from "@fdrive/core";
import { INDEX_ROOT_ID, type IndexedContent, type IndexQueries } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import type { ScopeResolver } from "../scoping/resolver.js";
import { roundTripVirtualPath } from "../scoping/round-trip.js";

export interface IndexedContentDeps {
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  readonly index: Pick<IndexQueries, "contentAt">;
}

/**
 * The live index rows behind some of a caller's files, by the normalized
 * virtual path asked for, in one query. A path is looked up only where the
 * identity's scopes map it to the index and back to itself
 * (`roundTripVirtualPath`), so no path a client chooses reaches a row
 * outside them, and a folder a nested scope shadows is never consulted.
 * Paths without a row are left out.
 */
export type IndexedContentLookup = (
  principal: Principal,
  paths: readonly string[],
) => Promise<ReadonlyMap<string, IndexedContent>>;

const SHA256 = /^[0-9a-f]{64}$/;

export function createIndexedContentLookup(deps: IndexedContentDeps): IndexedContentLookup {
  return async (principal, paths) => {
    const found = new Map<string, IndexedContent>();
    if (paths.length === 0) return found;
    const scopes = await deps.resolver.scopesFor(principal.username);
    // By `idx.files.path`, relative to the files folder.
    const wanted = new Map<string, string>();
    for (const path of paths) {
      const at = toFsPath(scopes, path);
      if (at === null || roundTripVirtualPath(scopes, at) !== path) continue;
      wanted.set(at.replace(/^\/+/, ""), path);
    }
    if (wanted.size === 0) return found;
    const rows = await deps.index.contentAt(
      [...wanted.keys()].map((path) => ({ rootId: INDEX_ROOT_ID, path })),
    );
    for (const row of rows) {
      const path = wanted.get(row.path);
      if (path !== undefined) found.set(path, row);
    }
    return found;
  };
}

/**
 * The indexed digest, when `row` provably describes the bytes of the file
 * `stamp` was just read from: the row is stamped (see `idx.files.inode`:
 * the indexer hashed those bytes itself, or the API hashed them as it wrote
 * them), and the file still has that inode and change time as well as the
 * row's size and modification time. A client can set a modification time but
 * neither of the other two, and any write moves the change time on, so size
 * and time alone never pass. Null otherwise: the caller hashes the file.
 */
export function indexedVersion(
  row: IndexedContent | undefined,
  stamp: ContentStamp,
): string | null {
  if (row === undefined || row.sha256 === null || !SHA256.test(row.sha256)) return null;
  if (row.inode === null || row.ctimeNs === null) return null;
  const same =
    row.size === stamp.size &&
    row.mtimeNs === stamp.mtimeNs &&
    row.inode === BigInt.asIntN(64, stamp.ino) &&
    row.ctimeNs === stamp.ctimeNs;
  return same ? row.sha256 : null;
}
