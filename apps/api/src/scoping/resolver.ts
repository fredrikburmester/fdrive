import { isSafeSegment, type Scope } from "@fdrive/core";
import type { ConfiguredMappingsResult, VerifiedIndexScopesResult } from "./types.ts";

/**
 * Where each login's files sit under the index roots. A login's home is
 * always `<root>/<username>` on the index root the files folder is read
 * under (`localIndexRoot`), shown at "/" in its virtual filesystem, plus one
 * scope per folder shared with it; nothing is configured per login. Scopes
 * are computed for every request from the username and the grants it has
 * now, so a revoked grant stops at once. See `docs/SCOPING.md`.
 */
export interface ScopeResolver {
  /**
   * The scopes of the login named `username`, whether or not their root is
   * indexed: index events and activity observations use these. One grants
   * query; reads neither storage nor the indexer.
   */
  configuredMappings(username: string): Promise<ConfiguredMappingsResult>;
  /**
   * The configured scopes of the login named `username` whose root is
   * indexed. Index-backed features (search, duplicates, thumbnails, folder
   * sizes, extraction, MCP) use this with their principal's username: an
   * index row these scopes map to is the login's to see.
   */
  verifiedIndexScopes(username: string): Promise<VerifiedIndexScopesResult>;
}

/**
 * More scopes for one login, appended after its home: for example another
 * user's folder shown at `/Shared with me/<name>`, as `{ rootName:
 * home.rootName, fsPrefix: "/<owner>/<path>", virtualPrefix: "/Shared with
 * me/<name>" }`. Each scope must be canonical, and its `virtualPrefix` must
 * not be "/". A scope nested inside the home shadows the home's own folder
 * at that path: the scope helpers pick the longest prefix, and
 * `roundTripVirtualPath` drops index rows from the shadowed folder.
 */
export type ExtraScopes = (username: string, home: Scope) => Promise<readonly Scope[]>;

export interface CreateScopeResolverDeps {
  /** The files folder's provider row, which Office keys its documents by. */
  readonly storageId: string;
  /** The index root the files folder is read under (`localIndexRoot`). */
  readonly rootName: string;
  /** The names in `FDRIVE_INDEX_ROOTS`; empty when nothing is indexed. */
  readonly indexRootNames: Iterable<string>;
  /** Defaults to none. */
  readonly extraScopes?: ExtraScopes;
}

/** Builds the `ScopeResolver`, the single source of truth for what logins may read from the index. */
export function createScopeResolver(deps: CreateScopeResolverDeps): ScopeResolver {
  const indexed = new Set(deps.indexRootNames);

  async function configuredMappings(username: string): Promise<ConfiguredMappingsResult> {
    const { rootName } = deps;
    // The username names the home folder, so it must be exactly one segment.
    if (!isSafeSegment(username)) {
      return { available: false, reason: "invalid_configuration" };
    }
    const home: Scope = { rootName, fsPrefix: `/${username}`, virtualPrefix: "/" };
    const extra = deps.extraScopes === undefined ? [] : await deps.extraScopes(username, home);
    return { available: true, providerId: deps.storageId, scopes: [home, ...extra] };
  }

  async function verifiedIndexScopes(username: string): Promise<VerifiedIndexScopesResult> {
    const configured = await configuredMappings(username);
    if (!configured.available) return configured;
    const scopes = configured.scopes.filter((scope) => indexed.has(scope.rootName));
    return scopes.length > 0
      ? { available: true, scopes }
      : { available: false, reason: "no_roots" };
  }

  return { configuredMappings, verifiedIndexScopes };
}
