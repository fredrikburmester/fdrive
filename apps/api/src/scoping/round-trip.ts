import { isWithin, normalizePath, type Scope, toFsPath, toVirtualPath } from "@fdrive/core";
import { SHARED_WITH_ME } from "@fdrive/local";

const SHELF = `/${SHARED_WITH_ME}`;

/**
 * Whether `virtualPath` is in `Shared with me` without being in a folder
 * shared with the login: in the home's own folder of that reserved name,
 * which stays out of sight.
 */
function inOwnShelf(scopes: readonly Scope[], virtualPath: string): boolean {
  return (
    isWithin(SHELF, virtualPath) &&
    !scopes.some(
      (scope) => scope.virtualPrefix !== "/" && isWithin(scope.virtualPrefix, virtualPath),
    )
  );
}

/**
 * Maps `fsPath`, a path in the files folder, to its virtual path and back,
 * and returns the virtual path only when the round trip lands on the exact
 * same `fsPath`. `null` in every other case: no scope covers the path, a
 * more specific scope shadows it (the virtual path resolves to another
 * path than it started from), or it lies in the home's own `Shared with
 * me`, a name reserved for the folders others share.
 *
 * Every index-derived or event-derived path must be filtered through this
 * before it is used to authorize or emit anything: a folder shared with the
 * login at `/Shared with me/Photos` hides the home's own `/alice/Shared with
 * me/Photos`, and a file that lives there must never be reachable through
 * that login.
 */
export function roundTripVirtualPath(scopes: readonly Scope[], fsPath: string): string | null {
  const virtualPath = toVirtualPath(scopes, fsPath);
  if (virtualPath === null || inOwnShelf(scopes, virtualPath)) {
    return null;
  }
  const back = toFsPath(scopes, virtualPath);
  if (back === null || normalizePath(back) !== normalizePath(fsPath)) {
    return null;
  }
  return virtualPath;
}
