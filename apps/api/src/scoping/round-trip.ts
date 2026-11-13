import { normalizePath, type Scope, toFsPath, toVirtualPath } from "@fdrive/core";

/**
 * Maps `fsPath` (within `rootName`) to its virtual path and back, and
 * returns the virtual path only when the round trip lands on the exact
 * same `(rootName, fsPath)`. `null` in every other case: no scope covers
 * the filesystem path, no scope covers the resulting virtual path, or a
 * more specific scope shadows the original location (the virtual path
 * resolves to a different root or filesystem path than it started from).
 *
 * Every index-derived or event-derived filesystem reference must be
 * filtered through this before it is used to authorize or emit anything:
 * a nested scope such as `/Shared with me/Photos` hides the home's own
 * `/alice/Shared with me/Photos` subtree, and a file that still lives at
 * the shadowed location must never be reachable through that identity.
 */
export function roundTripVirtualPath(
  scopes: readonly Scope[],
  rootName: string,
  fsPath: string,
): string | null {
  const virtualPath = toVirtualPath(scopes, rootName, fsPath);
  if (virtualPath === null) {
    return null;
  }

  const back = toFsPath(scopes, virtualPath);
  if (back === null || back.rootName !== rootName) {
    return null;
  }

  if (normalizePath(back.fsPath) !== normalizePath(fsPath)) {
    return null;
  }

  return virtualPath;
}
