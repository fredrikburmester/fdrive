import { isUnderPath, normalizePath, type Scope, toFsPath } from "@fdrive/core";
import type { Principal } from "../auth/principal.ts";

export function containsPath(root: string, path: string): boolean {
  return root === path || isUnderPath(root, path);
}

export function canReadPath(principal: Principal, rawPath: string): boolean {
  const path = normalizePath(rawPath);
  return (
    principal.tokenAccess === undefined ||
    principal.tokenAccess.paths.some((root) => containsPath(normalizePath(root), path))
  );
}

export function canBrowsePath(principal: Principal, rawPath: string): boolean {
  const path = normalizePath(rawPath);
  return (
    canReadPath(principal, path) ||
    principal.tokenAccess?.paths.some((root) => containsPath(path, normalizePath(root))) === true
  );
}

export function assertTokenPath(principal: Principal, rawPath: string): string {
  const path = normalizePath(rawPath);
  if (!canReadPath(principal, path))
    throw new Error("path is outside this token's allowed folders");
  return path;
}

export function canOrganize(principal: Principal, legacyWrites: boolean): boolean {
  return principal.tokenAccess === undefined ? legacyWrites : principal.tokenAccess.mode !== "read";
}

export function requireMode(
  principal: Principal,
  mode: "organize" | "full",
  legacyWrites = false,
): void {
  const allowed =
    mode === "organize"
      ? canOrganize(principal, legacyWrites)
      : principal.tokenAccess?.mode === "full";
  if (!allowed) throw new Error(`this token does not allow ${mode} operations`);
}

export interface TrashAccessDeps {
  readonly trashPath?: string | null;
  readonly trashPathForStorage?: (storage: Principal["storage"]) => string | null;
}

export function trashPathFor(deps: TrashAccessDeps, principal: Principal): string | null {
  return deps.trashPathForStorage?.(principal.storage) ?? deps.trashPath ?? null;
}

export function ordinaryPath(deps: TrashAccessDeps, principal: Principal, rawPath: string): string {
  const path = assertTokenPath(principal, rawPath);
  const trashPath = trashPathFor(deps, principal);
  if (trashPath !== null && containsPath(trashPath, path))
    throw new Error("path is in the configured Trash folder");
  return path;
}

export function requireExplicitAccess(principal: Principal): void {
  if (principal.tokenAccess === undefined)
    throw new Error("Create a token with explicit permissions to use this tool.");
}

/** Prevents moving/deleting a grant root and thereby invalidating or retargeting the grant. */
export function assertMutablePath(
  principal: Principal,
  path: string,
  trashPath: string | null,
): void {
  assertTokenPath(principal, path);
  if (
    path === "/" ||
    principal.tokenAccess?.paths.some((root) => containsPath(path, normalizePath(root)))
  ) {
    throw new Error("cannot move or delete an allowed folder root");
  }
  if (trashPath !== null && containsPath(path, trashPath))
    throw new Error("cannot move or delete a folder containing Trash");
}

/** Intersects virtual grants without removing the original mappings' shadow boundaries. */
export function intersectScopes(scopes: readonly Scope[], paths: readonly string[]): Scope[] {
  const result = new Map<string, Scope>();
  for (const scope of scopes) {
    for (const rawRoot of paths) {
      const root = normalizePath(rawRoot);
      const prefix = containsPath(root, scope.virtualPrefix)
        ? scope.virtualPrefix
        : containsPath(scope.virtualPrefix, root)
          ? root
          : null;
      if (prefix === null) continue;
      const local = toFsPath([scope], prefix);
      const actual = toFsPath(scopes, prefix);
      if (
        local === null ||
        actual === null ||
        local.rootName !== actual.rootName ||
        local.fsPath !== actual.fsPath
      )
        continue;
      const narrowed = { rootName: local.rootName, fsPrefix: local.fsPath, virtualPrefix: prefix };
      result.set(JSON.stringify(narrowed), narrowed);
    }
  }
  return [...result.values()];
}

export function tokenScopes(principal: Principal, scopes: readonly Scope[]): readonly Scope[] {
  return principal.tokenAccess === undefined
    ? scopes
    : intersectScopes(scopes, principal.tokenAccess.paths);
}
