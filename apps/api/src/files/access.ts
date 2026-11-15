import { parentPath } from "@fdrive/core";
import type { AccessChange, AccessRepo, DesktopShareMove, PathLock } from "@fdrive/db";

/**
 * Where `path`, a login's own path, lies in its owner's files: in a folder
 * shared with the login, the owner's login and path; anywhere else, the
 * login's own (`LocalGrantService.ownerPath`).
 */
export type OwnerPath = (
  identityId: string,
  path: string,
) => Promise<{ identityId: string; path: string }>;

/**
 * Changes what grants access to a login's paths in the file operation's
 * transaction (`AccessFollowers.run`). Paths are the login's own; each is
 * followed in its owner's files.
 */
export interface AccessFollow {
  /** `from` (and everything under it) moved to `to`. */
  moved(identityId: string, from: string, to: string, directory: boolean): Promise<void>;
  /** `path` (and everything under it) is gone for good. */
  removed(identityId: string, path: string, directory: boolean): Promise<void>;
}

/** The paths one file operation changes, in its login's files. */
export interface TouchedPaths {
  /** Paths it moves away or deletes: no other operation runs below one until it ends. */
  readonly vacates?: readonly string[];
  /** Paths it creates: it waits for an operation vacating one or a folder above. */
  readonly creates?: readonly string[];
}

/**
 * What grants access to a path follows its file wherever it goes, and never
 * stays at a path the file left, where a new item could appear: public
 * links, folders shared with people and Office files. Every file operation
 * changes them in one transaction with its storage call (`run`), and holds
 * the paths it vacates until that transaction ends, so a new item created
 * there in the meantime waits for what granted access to the old one to
 * have gone. Changes made outside fdrive follow afterwards (`moved`,
 * `removed`), once the change journal holds them.
 */
export interface AccessFollowers {
  run<T>(
    identityId: string,
    paths: TouchedPaths,
    work: (follow: AccessFollow) => Promise<T>,
  ): Promise<T>;
  moved(identityId: string, from: string, to: string, directory: boolean): Promise<void>;
  removed(identityId: string, path: string, directory: boolean): Promise<void>;
}

export interface AccessFollowersDeps {
  readonly repo: AccessRepo;
  readonly ownerPath: OwnerPath;
  /** Where public links go when `from` moved to `to` (`ShareMoves.resolve`). */
  readonly links: (
    identityId: string,
    from: string,
    to: string,
  ) => Promise<DesktopShareMove | null>;
  /** The local username of a login, which owns its folders shared with people; `null` once it is gone. */
  readonly usernameOf: (identityId: string) => Promise<string | null>;
}

/** `path` and every folder above it, root last. */
function withAncestors(path: string): string[] {
  const paths = [path];
  for (let folder = path; folder !== "/"; ) {
    folder = parentPath(folder);
    paths.push(folder);
  }
  return paths;
}

export function createAccessFollowers(deps: AccessFollowersDeps): AccessFollowers {
  const { ownerPath } = deps;

  /**
   * What a move of `from` to `to` in `identityId`'s files does in their
   * owners' files. Folders shared with people go where public links go
   * (`ShareMoves.resolve`); Office files follow into any owner's files.
   */
  async function planMove(
    identityId: string,
    from: string,
    to: string,
    directory: boolean,
  ): Promise<AccessChange | null> {
    if (from === to) return null;
    const [source, target, links] = await Promise.all([
      ownerPath(identityId, from),
      ownerPath(identityId, to),
      deps.links(identityId, from, to),
    ]);
    // An owner's root never moves; neither does a folder shared as a whole.
    const office = source.path === "/" || target.path === "/" ? null : { from: source, to: target };
    if (links === null && office === null) return null;
    const owner = links !== null && directory ? await deps.usernameOf(links.identityId) : null;
    return {
      directory,
      shares: links,
      grants: owner === null || links === null ? null : { owner, from: links.from, to: links.to },
      office,
    };
  }

  async function planRemove(
    identityId: string,
    path: string,
    directory: boolean,
  ): Promise<AccessChange | null> {
    const owned = await ownerPath(identityId, path);
    if (owned.path === "/") return null;
    const owner = directory ? await deps.usernameOf(owned.identityId) : null;
    return {
      directory,
      shares: { identityId: owned.identityId, from: owned.path, to: null },
      grants: owner === null ? null : { owner, from: owned.path, to: null },
      office: { from: owned, to: null },
    };
  }

  /** The locks `paths` need, in their owners' files. */
  async function locksFor(identityId: string, paths: TouchedPaths): Promise<PathLock[]> {
    const locks: PathLock[] = [];
    for (const [list, vacated] of [
      [paths.vacates ?? [], true],
      [paths.creates ?? [], false],
    ] as const)
      for (const path of list) {
        const owned = await ownerPath(identityId, path);
        for (const each of withAncestors(owned.path))
          locks.push({
            identityId: owned.identityId,
            path: each,
            exclusive: vacated && each === owned.path,
          });
      }
    return locks;
  }

  function followIn(apply: (change: AccessChange) => Promise<void>): AccessFollow {
    return {
      async moved(identityId, from, to, directory) {
        const change = await planMove(identityId, from, to, directory);
        if (change !== null) await apply(change);
      },
      async removed(identityId, path, directory) {
        const change = await planRemove(identityId, path, directory);
        if (change !== null) await apply(change);
      },
    };
  }

  return {
    async run(identityId, paths, work) {
      const locks = await locksFor(identityId, paths);
      return deps.repo.run(locks, (apply) => work(followIn(apply)));
    },
    moved: (identityId, from, to, directory) =>
      deps.repo.run([], (apply) => followIn(apply).moved(identityId, from, to, directory)),
    removed: (identityId, path, directory) =>
      deps.repo.run([], (apply) => followIn(apply).removed(identityId, path, directory)),
  };
}
