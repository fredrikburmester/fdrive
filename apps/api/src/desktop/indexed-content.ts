import { type ContentStamp, toFsPath } from "@fdrive/core";
import type { IdentityRepo, IndexedContent, IndexQueries, IndexRef } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import type { ScopeResolver } from "../scoping/resolver.js";
import { roundTripVirtualPath } from "../scoping/round-trip.js";

export interface IndexedContentDeps {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly index: Pick<IndexQueries, "contentAt">;
}

/**
 * The live index rows behind some of a caller's files, by the normalized
 * virtual path asked for, in one query. A path is looked up only where the
 * identity's verified index scopes map it to the index and back to itself
 * (`roundTripVirtualPath`), so no path a client chooses reaches a row
 * outside them, and a folder a nested scope shadows is never consulted.
 * Paths without a row are left out.
 */
export type IndexedContentLookup = (
  principal: Principal,
  paths: readonly string[],
) => Promise<ReadonlyMap<string, IndexedContent>>;

const SHA256 = /^[0-9a-f]{64}$/;
const key = (ref: IndexRef) => JSON.stringify([ref.rootName, ref.path]);

export function createIndexedContentLookup(deps: IndexedContentDeps): IndexedContentLookup {
  return async (principal, paths) => {
    const found = new Map<string, IndexedContent>();
    if (paths.length === 0) return found;
    const identity = await deps.identities.get(principal.identityId);
    if (identity === null) return found;
    const verified = await deps.resolver.verifiedIndexScopes(identity);
    if (!verified.available) return found;
    const wanted = new Map<string, { ref: IndexRef; path: string }>();
    for (const path of paths) {
      const at = toFsPath(verified.scopes, path);
      if (at === null || roundTripVirtualPath(verified.scopes, at.rootName, at.fsPath) !== path)
        continue;
      // `idx.files.path` is root-relative.
      const ref = { rootName: at.rootName, path: at.fsPath.replace(/^\/+/, "") };
      wanted.set(key(ref), { ref, path });
    }
    if (wanted.size === 0) return found;
    const rows = await deps.index.contentAt([...wanted.values()].map((item) => item.ref));
    const byRef = new Map(rows.map((row) => [key(row), row]));
    for (const [ref, item] of wanted) {
      const row = byRef.get(ref);
      if (row !== undefined) found.set(item.path, row);
    }
    return found;
  };
}

/**
 * The indexed digest, when `row` provably describes the bytes of the file
 * `stamp` was just read from: the indexer's own read stamped the row (see
 * `idx.files.inode`), and the file still has that inode and change time as
 * well as the row's size and modification time. A client can set a
 * modification time but neither of the other two, and any write moves the
 * change time on, so size and time alone never pass. Null otherwise: the
 * caller hashes the file.
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
