import { CoreError } from "./errors.js";
import { isSafeSegment, isWithin, joinPath, normalizePath } from "./paths.js";

/**
 * A mapping between a slice of one storage root's filesystem tree and a
 * slice of the user's virtual filesystem. `fsPrefix` is a normalized path
 * relative to the root's mount ("/alice" means the directory "alice"
 * directly under the root). `virtualPrefix` is the virtual path the user
 * sees for that slice ("/" for their home).
 */
export interface Scope {
  readonly rootName: string;
  readonly fsPrefix: string;
  readonly virtualPrefix: string;
}

/** A parsed `FDRIVE_HOME_TEMPLATE`, see `parseHomeTemplate`. */
export interface HomeTemplate {
  readonly rootName: string;
  readonly pathTemplate: string;
}

const ROOT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const USERNAME_PLACEHOLDER = "{username}";

/**
 * Parses a home template of the form `<rootName>:<path with {username}>`,
 * for example the default `"sftpgo:/{username}"`.
 *
 * `rootName` must match `/^[a-z0-9][a-z0-9_-]*$/`. The path part may
 * contain `{username}` at most once, and must normalize cleanly once the
 * placeholder is substituted. Throws `CoreError("invalid_template")`
 * otherwise.
 */
export function parseHomeTemplate(template: string): HomeTemplate {
  const separatorIndex = template.indexOf(":");
  if (separatorIndex <= 0) {
    throw new CoreError("invalid_template", 'template must be "<rootName>:<path>"', { template });
  }

  const rootName = template.slice(0, separatorIndex);
  const pathTemplate = template.slice(separatorIndex + 1);

  if (!ROOT_NAME_PATTERN.test(rootName)) {
    throw new CoreError("invalid_template", "invalid root name", { rootName });
  }

  const placeholderCount = pathTemplate.split(USERNAME_PLACEHOLDER).length - 1;
  if (placeholderCount > 1) {
    throw new CoreError("invalid_template", "{username} may appear at most once", { template });
  }

  try {
    normalizePath(pathTemplate.replaceAll(USERNAME_PLACEHOLDER, "probe"));
  } catch {
    throw new CoreError("invalid_template", "template path does not normalize cleanly", {
      template,
    });
  }

  return { rootName, pathTemplate };
}

/** The default home template used when no `FDRIVE_HOME_TEMPLATE` is set. */
export const DEFAULT_HOME_TEMPLATE: HomeTemplate = parseHomeTemplate("sftpgo:/{username}");

/**
 * Builds the list of scopes for one identity: the home scope derived from
 * `template` and `username` first, followed by any `overrides`. Overrides
 * are normalized; an override whose `virtualPrefix` matches the home scope
 * replaces it rather than duplicating it, and duplicate `virtualPrefix`
 * values among the overrides keep the last one given.
 *
 * Throws `CoreError("invalid_argument")` when `username` is not a safe
 * path segment.
 */
export function scopesFor(input: {
  readonly template: HomeTemplate;
  readonly username: string;
  readonly overrides?: readonly Scope[];
}): Scope[] {
  const { template, username, overrides = [] } = input;

  if (!isSafeSegment(username)) {
    throw new CoreError("invalid_argument", "username is not a safe path segment", { username });
  }

  const homeScope: Scope = {
    rootName: template.rootName,
    fsPrefix: normalizePath(template.pathTemplate.replaceAll(USERNAME_PLACEHOLDER, username)),
    virtualPrefix: "/",
  };

  const byVirtualPrefix = new Map<string, Scope>();
  byVirtualPrefix.set(homeScope.virtualPrefix, homeScope);

  for (const override of overrides) {
    const normalized: Scope = {
      rootName: override.rootName,
      fsPrefix: normalizePath(override.fsPrefix),
      virtualPrefix: normalizePath(override.virtualPrefix),
    };
    byVirtualPrefix.set(normalized.virtualPrefix, normalized);
  }

  return Array.from(byVirtualPrefix.values());
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
