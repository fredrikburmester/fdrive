import type { FsEntry } from "@fdrive/contracts";
import type {
  Tag as DbTag,
  FavoriteKind,
  FavoriteRepo,
  FileTagRepo,
  FolderViewMode,
  FolderViewRepo,
  FolderViewSort,
  IdentityRepo,
  RecentRepo,
  TagRepo,
} from "@fdrive/db";

/** The subset of `Tag` exposed over the API: an account's tags never carry their `accountId`. */
export interface MetadataTag {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

export interface MetadataFavoriteItem {
  readonly path: string;
  readonly kind: FavoriteKind;
  readonly addedAt: Date;
}

export interface MetadataRecentItem {
  readonly path: string;
  readonly openedAt: Date;
}

export interface MetadataFolderView {
  readonly path: string;
  readonly mode: FolderViewMode;
  readonly sort: FolderViewSort | null;
}

export interface MetadataServiceDeps {
  readonly tags: TagRepo;
  readonly fileTags: FileTagRepo;
  readonly favorites: FavoriteRepo;
  readonly folderViews: FolderViewRepo;
  readonly identities: Pick<IdentityRepo, "listByAccount">;
  readonly recents: RecentRepo;
}

/** How many recent entries `RecentRepo.prune` keeps per identity after each `touchRecent`. */
export const RECENTS_KEEP = 200;

/** Default number of items `listRecents` returns when the caller does not ask for a specific limit. */
export const DEFAULT_RECENTS_LIMIT = 50;

/** Thrown by `setFileTags` when a requested tag id is not one of the account's own tags. */
export class UnknownTagError extends Error {
  readonly tagIds: readonly string[];

  constructor(tagIds: readonly string[]) {
    super(`unknown tag: ${tagIds.join(", ")}`);
    this.name = "UnknownTagError";
    this.tagIds = tagIds;
  }
}

function toMetadataTag(tag: DbTag): MetadataTag {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/**
 * The metadata use cases shared by the tags, favorites, and recents routes,
 * plus the hooks `fs/routes.ts` calls after a move or delete so tag and
 * favorite and folder-view metadata survives renames made through fdrive itself. Renames and
 * deletes seen via the indexer (SFTP, WebDAV, other clients) reach the same
 * hooks through `events/indexer-listener.ts`.
 */
export interface MetadataService {
  /**
   * Adds `meta: { tagIds, favorite }` to every entry, in exactly one round
   * trip to `fileTags` and one to `favorites`.
   */
  decorate(identityId: string, entries: readonly FsEntry[]): Promise<FsEntry[]>;
  listTags(accountId: string): Promise<MetadataTag[]>;
  createTag(accountId: string, input: { name: string; color: string | null }): Promise<MetadataTag>;
  updateTag(
    accountId: string,
    id: string,
    patch: { name?: string; color?: string | null },
  ): Promise<MetadataTag | null>;
  deleteTag(accountId: string, id: string): Promise<void>;
  filesForTag(identityId: string, tagId: string): Promise<string[]>;
  /**
   * Replaces the tags on `path` for `identityId`. Every id in `tagIds` must
   * name a tag owned by `accountId`; otherwise throws
   * `UnknownTagError` and writes nothing, so one account can never attach
   * (or probe for) another account's tags.
   */
  setFileTags(
    owner: { accountId: string; identityId: string },
    path: string,
    tagIds: readonly string[],
  ): Promise<void>;
  listFavorites(identityId: string): Promise<MetadataFavoriteItem[]>;
  addFavorite(identityId: string, path: string, kind: FavoriteKind): Promise<void>;
  removeFavorite(identityId: string, path: string): Promise<void>;
  getFolderView(identityId: string, path: string): Promise<MetadataFolderView | null>;
  setFolderView(identityId: string, path: string, mode: FolderViewMode): Promise<void>;
  removeFolderView(identityId: string, path: string): Promise<void>;
  /** Resets every folder pin owned through every identity linked to `accountId`. */
  resetFolderViews(accountId: string): Promise<void>;
  listRecents(identityId: string, limit?: number): Promise<MetadataRecentItem[]>;
  touchRecent(identityId: string, path: string): Promise<void>;
  /** Rewrites tag, favorite, and recent paths after a move or rename made through fdrive or seen on disk. */
  onMoved(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  /** Drops tag, favorite, and recent rows after a delete made through fdrive or seen on disk. */
  onDeleted(identityId: string, path: string, isDir: boolean): Promise<void>;
  /**
   * Drops only the recent-files entries after a delete that moved the item
   * into the storage provider's trash instead of removing it. Tags and
   * favorites are left in place (keyed at the original path) so a
   * same-path restore recovers them; a restore to a different target
   * without an index configured loses them.
   */
  onTrashed(identityId: string, path: string, isDir: boolean): Promise<void>;
  /**
   * No-op by design: a copy is a brand new file as far as metadata is
   * concerned, so tags, favorites, and recents on the source are never
   * duplicated onto the copy. Kept as an explicit method (rather than
   * omitted) so call sites document the decision instead of silently doing
   * nothing.
   */
  onCopied(identityId: string, path: string, target: string): void;
}

/**
 * Whether `identityId` has any tags or a favorite recorded at exactly
 * `path`. Used by the indexer listener's sha256 relink fallback: only a path
 * that was actually tracked is worth reconciling when it disappears.
 */
export async function hasTrackedMetadata(
  deps: Pick<MetadataServiceDeps, "fileTags" | "favorites"> &
    Partial<Pick<MetadataServiceDeps, "folderViews">>,
  identityId: string,
  path: string,
): Promise<boolean> {
  const [tagsByPath, favoritedPaths, hasFolderView] = await Promise.all([
    deps.fileTags.tagsForPaths(identityId, [path]),
    deps.favorites.has(identityId, [path]),
    deps.folderViews?.has(identityId, path) ?? false,
  ]);
  return (tagsByPath.get(path)?.length ?? 0) > 0 || favoritedPaths.has(path) || hasFolderView;
}

export function createMetadataService(deps: MetadataServiceDeps): MetadataService {
  return {
    async decorate(identityId, entries) {
      const paths = entries.map((entry) => entry.path);
      const [tagsByPath, favoritedPaths] = await Promise.all([
        deps.fileTags.tagsForPaths(identityId, paths),
        deps.favorites.has(identityId, paths),
      ]);
      return entries.map((entry) => ({
        ...entry,
        meta: {
          tagIds: tagsByPath.get(entry.path) ?? [],
          favorite: favoritedPaths.has(entry.path),
        },
      }));
    },

    async listTags(accountId) {
      const tags = await deps.tags.list(accountId);
      return tags.map(toMetadataTag);
    },

    async createTag(accountId, input) {
      const tag = await deps.tags.create(accountId, input);
      return toMetadataTag(tag);
    },

    async updateTag(accountId, id, patch) {
      const tag = await deps.tags.update(id, accountId, patch);
      return tag ? toMetadataTag(tag) : null;
    },

    async deleteTag(accountId, id) {
      await deps.tags.delete(id, accountId);
    },

    filesForTag(identityId, tagId) {
      return deps.fileTags.pathsForTag(identityId, tagId);
    },

    async setFileTags(owner, path, tagIds) {
      if (tagIds.length > 0) {
        const owned = new Set((await deps.tags.list(owner.accountId)).map((tag) => tag.id));
        const unknown = tagIds.filter((id) => !owned.has(id));
        if (unknown.length > 0) throw new UnknownTagError(unknown);
      }
      return deps.fileTags.setTags(owner.identityId, path, tagIds);
    },

    async listFavorites(identityId) {
      const favorites = await deps.favorites.list(identityId);
      return favorites.map((favorite) => ({
        path: favorite.path,
        kind: favorite.kind,
        addedAt: favorite.createdAt,
      }));
    },

    addFavorite(identityId, path, kind) {
      return deps.favorites.add(identityId, path, kind);
    },

    removeFavorite(identityId, path) {
      return deps.favorites.remove(identityId, path);
    },

    async getFolderView(identityId, path) {
      const view = await deps.folderViews.get(identityId, path);
      return view === null ? null : { path: view.path, mode: view.mode, sort: view.sort };
    },

    setFolderView(identityId, path, mode) {
      return deps.folderViews.set(identityId, path, mode);
    },

    removeFolderView(identityId, path) {
      return deps.folderViews.remove(identityId, path);
    },

    async resetFolderViews(accountId) {
      const identities = await deps.identities.listByAccount(accountId);
      await Promise.all(identities.map((identity) => deps.folderViews.clear(identity.id)));
    },

    async listRecents(identityId, limit = DEFAULT_RECENTS_LIMIT) {
      const recents = await deps.recents.list(identityId, limit);
      return recents.map((recent) => ({ path: recent.path, openedAt: recent.openedAt }));
    },

    async touchRecent(identityId, path) {
      await deps.recents.touch(identityId, path);
      await deps.recents.prune(identityId, RECENTS_KEEP);
    },

    async onMoved(identityId, oldPath, newPath, isDir) {
      await Promise.all([
        deps.fileTags.movePrefix(identityId, oldPath, newPath, isDir),
        deps.favorites.movePrefix(identityId, oldPath, newPath, isDir),
        deps.folderViews.movePrefix(identityId, oldPath, newPath, isDir),
        deps.recents.movePrefix(identityId, oldPath, newPath, isDir),
      ]);
    },

    async onDeleted(identityId, path, isDir) {
      await Promise.all([
        deps.fileTags.deletePrefix(identityId, path, isDir),
        deps.favorites.deletePrefix(identityId, path, isDir),
        deps.folderViews.deletePrefix(identityId, path, isDir),
        deps.recents.deletePrefix(identityId, path, isDir),
      ]);
    },

    async onTrashed(identityId, path, isDir) {
      await deps.recents.deletePrefix(identityId, path, isDir);
    },

    onCopied() {
      // Intentionally empty: see the `onCopied` doc comment above.
    },
  };
}
