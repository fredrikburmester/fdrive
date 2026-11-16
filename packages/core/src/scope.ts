import { isWithin, joinPath, normalizePath } from "./paths.ts";

/**
 * A mapping between a slice of the files folder and a slice of the user's
 * virtual filesystem. `fsPrefix` is a normalized path relative to the files
 * folder ("/alice" means the folder "alice" directly in it). `virtualPrefix`
 * is the virtual path the user sees for that slice ("/" for their home). An
 * identity may carry several scopes, nested ones included: the longest
 * matching prefix wins in both directions.
 */
export interface Scope {
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
 * Maps a virtual path to its path in the files folder by picking the scope
 * with the longest matching `virtualPrefix`. `null` when no scope covers it.
 */
export function toFsPath(scopes: readonly Scope[], virtualPath: string): string | null {
  const normalizedVirtual = normalizePath(virtualPath);
  const matches = scopes.filter((scope) => isWithin(scope.virtualPrefix, normalizedVirtual));
  const best = longestBy(matches, (scope) => scope.virtualPrefix.length);
  if (best === null) {
    return null;
  }

  const rel = stripPrefix(best.virtualPrefix, normalizedVirtual);
  return rel === "" ? best.fsPrefix : joinPath(best.fsPrefix, rel);
}

/**
 * Maps a path in the files folder back to a virtual path by picking the
 * scope with the longest matching `fsPrefix`. `null` when no scope covers
 * it.
 */
export function toVirtualPath(scopes: readonly Scope[], fsPath: string): string | null {
  const normalizedFs = normalizePath(fsPath);
  const matches = scopes.filter((scope) => isWithin(scope.fsPrefix, normalizedFs));
  const best = longestBy(matches, (scope) => scope.fsPrefix.length);
  if (best === null) {
    return null;
  }

  const rel = stripPrefix(best.fsPrefix, normalizedFs);
  return rel === "" ? best.virtualPrefix : joinPath(best.virtualPrefix, rel);
}
