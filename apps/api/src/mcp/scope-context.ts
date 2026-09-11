import type { Scope } from "@fdrive/core";
import { isUnderPath, toFsPath } from "@fdrive/core";
import type { IndexQueries, ScopePrefix } from "@fdrive/db";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";

/**
 * Everything an MCP tool needs to translate between a principal's virtual
 * paths and the index's (rootId, fs path) rows, resolved once per tool call
 * from the caller's `ScopeResolver.verifiedIndexScopes(identity)` result.
 * Never built from a username/template fallback; see
 * `docs/SCOPING.md`.
 */
export interface ScopeContext {
  readonly scopes: readonly Scope[];
  readonly scopePrefixes: readonly ScopePrefix[];
  readonly rootNameById: ReadonlyMap<number, string>;
  readonly rootIdByName: ReadonlyMap<string, number>;
  /**
   * The storage provider's recycle folder virtual path, when configured.
   * `virtualPathFor` treats a path at or under this prefix as unmapped, so
   * trashed files never appear in MCP tool results (`find_files`,
   * `find_duplicates`, `similar_files`, `folder_overview`, `recent_moves`,
   * ...).
   */
  readonly trashPath: string | null;
}

/**
 * Resolves the scope context for `scopes` (an identity's already *verified*
 * index scopes, from `ScopeResolver.verifiedIndexScopes`), or `null` when
 * index-backed tools are unavailable: `scopes` is empty, or none of it lands
 * on a root the index actually has a row for yet.
 */
export async function resolveScopeContext(
  indexQueries: Pick<IndexQueries, "rootIdsByName">,
  scopes: readonly Scope[],
  trashPath: string | null,
): Promise<ScopeContext | null> {
  if (scopes.length === 0) {
    return null;
  }

  const rootIds = await indexQueries.rootIdsByName();
  const rootIdByName = new Map(Object.entries(rootIds));
  const rootNameById = new Map<number, string>();
  for (const [name, id] of rootIdByName) {
    rootNameById.set(id, name);
  }

  const scopePrefixes: ScopePrefix[] = [];
  for (const scope of scopes) {
    const rootId = rootIdByName.get(scope.rootName);
    if (rootId !== undefined) {
      scopePrefixes.push({ rootId, fsPrefix: scope.fsPrefix });
    }
  }
  if (scopePrefixes.length === 0) {
    return null;
  }

  return { scopes, scopePrefixes, rootNameById, rootIdByName, trashPath };
}

/**
 * Maps `(rootId, fsPath)` back to the caller's virtual path, `null` when out
 * of scope, when a more specific override shadows this exact location (see
 * `roundTripVirtualPath`), or (per `ctx.trashPath`) inside the trash. Every
 * index-derived candidate must be filtered through this before it can
 * contribute to a tool's result; it is never sufficient on its own, though:
 * callers still need a live read check (`ReadAuthorizer`) before returning
 * any content, name, hash, or aggregate derived from the candidate.
 */
export function virtualPathFor(ctx: ScopeContext, rootId: number, fsPath: string): string | null {
  const rootName = ctx.rootNameById.get(rootId);
  if (rootName === undefined) {
    return null;
  }
  const virtualPath = roundTripVirtualPath(ctx.scopes, rootName, fsPath);
  if (virtualPath === null) {
    return null;
  }
  if (
    ctx.trashPath !== null &&
    (virtualPath === ctx.trashPath || isUnderPath(ctx.trashPath, virtualPath))
  ) {
    return null;
  }
  return virtualPath;
}

/**
 * Narrows `ctx.scopePrefixes` to just the folder at `virtualPathPrefix`
 * (a single `ScopePrefix`), or returns every scope prefix unchanged when
 * `virtualPathPrefix` is `undefined`. `null` when `virtualPathPrefix` does
 * not resolve within any scope, or resolves to a root the index does not
 * (yet) know about.
 */
export function narrowScopePrefixes(
  ctx: ScopeContext,
  virtualPathPrefix: string | undefined,
): ScopePrefix[] | null {
  if (virtualPathPrefix === undefined) {
    return [...ctx.scopePrefixes];
  }
  const resolved = toFsPath(ctx.scopes, virtualPathPrefix);
  if (resolved === null) {
    return null;
  }
  const rootId = ctx.rootIdByName.get(resolved.rootName);
  if (rootId === undefined) {
    return null;
  }
  return [{ rootId, fsPrefix: resolved.fsPath }];
}
