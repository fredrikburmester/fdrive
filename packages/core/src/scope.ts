import { isWithin, joinPath, normalizePath } from "./paths.ts";

/**
 * A mapping between a slice of one storage root's filesystem tree and a
 * slice of the user's virtual filesystem. `fsPrefix` is a normalized path
 * relative to the root's mount ("/alice" means the directory "alice"
 * directly under the root). `virtualPrefix` is the virtual path the user
 * sees for that slice ("/" for their home). An identity may carry several
 * scopes, nested ones included: the longest matching prefix wins in both
 * directions.
 */
export interface Scope {
  readonly rootName: string;
  readonly fsPrefix: string;
  readonly virtualPrefix: string;
}

/**
 * Removes `prefix` from the front of `path`, returning the remainder as
 * segments joined by "/" ("" when they are equal). Callers must already
 * know `path` is within `prefix` (normalized); this does no checking of
 * its own.
 */
function stripPrefix(prefix: string, path: string): string {
  if (path === prefix) {
    return "";
  }
  return prefix === "/" ? path.slice(1) : path.slice(prefix.length + 1);
}

function longestBy<T>(candidates: T[], length: (item: T) => number): T | null {
  let best: T | null = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    const candidateLength = length(candidate);
    if (candidateLength > bestLength) {
      best = candidate;
      bestLength = candidateLength;
    }
  }
  return best;
}

/**
 * Maps a virtual path to its filesystem location by picking the scope with
 * the longest matching `virtualPrefix`. `null` when no scope covers it.
 */
export function toFsPath(
  scopes: readonly Scope[],
  virtualPath: string,
): { rootName: string; fsPath: string } | null {
  const normalizedVirtual = normalizePath(virtualPath);
  const matches = scopes.filter((scope) => isWithin(scope.virtualPrefix, normalizedVirtual));
  const best = longestBy(matches, (scope) => scope.virtualPrefix.length);
  if (best === null) {
    return null;
  }

  const rel = stripPrefix(best.virtualPrefix, normalizedVirtual);
  const fsPath = rel === "" ? best.fsPrefix : joinPath(best.fsPrefix, rel);
  return { rootName: best.rootName, fsPath };
}

/**
 * Maps a filesystem path within `rootName` back to a virtual path by
 * picking the scope with the longest matching `fsPrefix`. `null` when no
 * scope of that root covers it.
 */
export function toVirtualPath(
  scopes: readonly Scope[],
  rootName: string,
  fsPath: string,
): string | null {
  const normalizedFs = normalizePath(fsPath);
  const matches = scopes.filter(
    (scope) => scope.rootName === rootName && isWithin(scope.fsPrefix, normalizedFs),
  );
  const best = longestBy(matches, (scope) => scope.fsPrefix.length);
  if (best === null) {
    return null;
  }

  const rel = stripPrefix(best.fsPrefix, normalizedFs);
  return rel === "" ? best.virtualPrefix : joinPath(best.virtualPrefix, rel);
}

/**
 * Filters `items` down to those whose filesystem reference falls within
 * any of `scopes`, pairing each with its virtual path.
 */
export function filterInScope<T>(
  scopes: readonly Scope[],
  items: readonly T[],
  getFsRef: (item: T) => { rootName: string; fsPath: string },
): { item: T; virtualPath: string }[] {
  const result: { item: T; virtualPath: string }[] = [];
  for (const item of items) {
    const ref = getFsRef(item);
    const virtualPath = toVirtualPath(scopes, ref.rootName, ref.fsPath);
    if (virtualPath !== null) {
      result.push({ item, virtualPath });
    }
  }
  return result;
}

/** The `(rootName, fsPrefix)` pairs for `scopes`, for building SQL filters. */
export function scopePrefixes(scopes: readonly Scope[]): { rootName: string; fsPrefix: string }[] {
  return scopes.map((scope) => ({ rootName: scope.rootName, fsPrefix: scope.fsPrefix }));
}
