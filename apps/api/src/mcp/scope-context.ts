import type { Scope } from "@fdrive/core";
import { isReservedPath, toFsPath } from "@fdrive/core";
import type { IndexExclusion, ScopePrefix } from "@fdrive/db";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import { indexPrefixes, reservedExclusion } from "../search/scopes.ts";

/**
 * Everything an MCP tool needs to translate between a principal's virtual
 * paths and the index's rows, resolved once per tool call from the caller's
 * `ScopeResolver.scopesFor` result. Never built from a username/template
 * fallback; see `docs/SCOPING.md`.
 */
export interface ScopeContext {
  readonly scopes: readonly Scope[];
  readonly scopePrefixes: readonly ScopePrefix[];
  /**
   * The login's Trash folder virtual path, when Trash is on. With it, every
   * query leaves fdrive's own folders out (`reservedExclusionOf`) and
   * `virtualPathFor` never maps a row into one, so they never appear in MCP
   * tool results (`find_files`, `find_duplicates`, `similar_files`,
   * `folder_overview`, `recent_moves`, ...).
   */
  readonly trashPath: string | null;
}

/**
 * fdrive's own folders (`isReservedPath`) in `ctx`'s index coordinates, for
 * every query a tool runs to leave out before its limit, so pages are full
 * and totals count only what the tool can return.
 */
export function reservedExclusionOf(ctx: ScopeContext): IndexExclusion {
  return reservedExclusion(ctx.scopes, ctx.trashPath);
}

/**
 * The scope context for `scopes` (an identity's scopes, from
 * `ScopeResolver.scopesFor`, narrowed to a token's folders), or `null` when
 * nothing is left of them.
 */
export function resolveScopeContext(
  scopes: readonly Scope[],
  trashPath: string | null,
): ScopeContext | null {
  if (scopes.length === 0) {
    return null;
  }
  return { scopes, scopePrefixes: indexPrefixes(scopes), trashPath };
}

/**
 * Maps a row's path in the files folder back to the caller's virtual path,
 * `null` when out of scope, when a more specific scope shadows this exact
 * location (see `roundTripVirtualPath`), or in one of fdrive's own folders
 * (`isReservedPath`, per `ctx.trashPath`), which a lookup by id or exact
 * path does not leave out on its own. Every index-derived candidate must be
 * filtered through this before it can contribute to a tool's result; one
 * that maps is the caller's to see, with no storage read.
 */
export function virtualPathFor(ctx: ScopeContext, fsPath: string): string | null {
  const virtualPath = roundTripVirtualPath(ctx.scopes, fsPath);
  if (virtualPath === null) {
    return null;
  }
  return isReservedPath(virtualPath, ctx.trashPath) ? null : virtualPath;
}

/**
 * Narrows `ctx.scopePrefixes` to just the folder at `virtualPathPrefix`
 * (a single `ScopePrefix`), or returns every scope prefix unchanged when
 * `virtualPathPrefix` is `undefined`. `null` when `virtualPathPrefix` does
 * not resolve within any scope.
 */
export function narrowScopePrefixes(
  ctx: ScopeContext,
  virtualPathPrefix: string | undefined,
): ScopePrefix[] | null {
  if (virtualPathPrefix === undefined) {
    return [...ctx.scopePrefixes];
  }
  const fsPath = toFsPath(ctx.scopes, virtualPathPrefix);
  return fsPath === null ? null : indexPrefixes([{ fsPrefix: fsPath, virtualPrefix: "/" }]);
}
