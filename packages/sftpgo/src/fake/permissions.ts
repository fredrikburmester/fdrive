/**
 * Resolves the permission strings that apply to a virtual path, mirroring
 * SFTPGo: `permissions` maps a directory path to the actions allowed within
 * it, and the longest matching prefix wins. A key of "/" matches every
 * path. A trailing slash on a key (other than the root) is ignored.
 */
export function resolvePermissions(
  permissions: Readonly<Record<string, readonly string[]>>,
  path: string,
): readonly string[] {
  let bestKey = "";
  let bestPerms: readonly string[] = [];
  let matched = false;

  for (const [rawKey, permsForKey] of Object.entries(permissions)) {
    const key = normalizeDirKey(rawKey);
    const isMatch = key === "/" || path === key || path.startsWith(`${key}/`);
    if (isMatch && key.length >= bestKey.length) {
      bestKey = key;
      bestPerms = permsForKey;
      matched = true;
    }
  }

  return matched ? bestPerms : [];
}

function normalizeDirKey(key: string): string {
  return key.length > 1 && key.endsWith("/") ? key.slice(0, -1) : key;
}

/** True when the permission list grants `action`, either directly or via the "*" wildcard. */
export function hasAction(perms: readonly string[], action: string): boolean {
  return perms.includes("*") || perms.includes(action);
}

/** True when the permission list grants any of `actions`. */
export function hasAnyAction(perms: readonly string[], actions: readonly string[]): boolean {
  return actions.some((action) => hasAction(perms, action));
}
