import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateIdentityLinkId } from "../repos/identity-links-types.js";
import type {
  Account,
  AccountRepo,
  ApiToken,
  ApiTokenRepo,
  Credential,
  CredentialRepo,
  Favorite,
  FavoriteKind,
  FavoriteRepo,
  FileTagRepo,
  FolderView,
  FolderViewMode,
  FolderViewRepo,
  FolderViewSort,
  Identity,
  IdentityRepo,
  MetadataPathRepo,
  Provider,
  ProviderRepo,
  Recent,
  RecentRepo,
  Repos,
  Session,
  SessionRepo,
  SettingsRepo,
  SystemEvent,
  SystemEventRepo,
  Tag,
  TagRepo,
} from "../repos/types.js";
import { ConflictError, levelsAtLeast } from "../repos/types.js";

export interface CreateMemoryReposOptions {
  /** Id generator, defaults to `crypto.randomUUID`. Override for deterministic tests. */
  readonly ids?: () => string;
}

function createMemoryProviderRepo(
  ids: () => string,
  identityCount: (providerId: string) => number,
): ProviderRepo {
  const byId = new Map<string, Provider>();
  const keyOf = (type: string, baseUrl: string) => `${type}\0${baseUrl}`;

  return {
    async get(id) {
      validateIdentityLinkId(id);
      return byId.get(id) ?? null;
    },
    async list() {
      return [...byId.values()];
    },
    async create(input) {
      for (const provider of byId.values()) {
        if (keyOf(provider.type, provider.baseUrl) === keyOf(input.type, input.baseUrl))
          throw new ConflictError("provider endpoint already exists");
      }
      const provider: Provider = {
        id: ids(),
        type: input.type,
        baseUrl: input.baseUrl,
        label: input.label ?? "",
        config: { ...input.config },
        enabled: input.enabled ?? true,
        managedByEnv: input.managedByEnv ?? false,
        createdAt: new Date(),
      };
      byId.set(provider.id, provider);
      return provider;
    },
    async ensure(input) {
      for (const provider of byId.values()) {
        if (keyOf(provider.type, provider.baseUrl) === keyOf(input.type, input.baseUrl)) {
          return provider;
        }
      }
      const provider: Provider = {
        id: ids(),
        type: input.type,
        baseUrl: input.baseUrl,
        label: "",
        config: {},
        enabled: true,
        managedByEnv: false,
        createdAt: new Date(),
      };
      byId.set(provider.id, provider);
      return provider;
    },
    async update(id, patch) {
      validateIdentityLinkId(id);
      const existing = byId.get(id);
      if (!existing) {
        return null;
      }
      if (
        patch.baseUrl !== undefined &&
        patch.baseUrl !== existing.baseUrl &&
        identityCount(id) > 0
      ) {
        throw new ConflictError("provider is still used by identities");
      }
      if (
        [...byId.values()].some(
          (row) =>
            row.id !== id &&
            keyOf(row.type, row.baseUrl) ===
              keyOf(existing.type, patch.baseUrl ?? existing.baseUrl),
        )
      )
        throw new ConflictError("provider endpoint already exists");
      const next: Provider = {
        ...existing,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
        ...(patch.config !== undefined ? { config: { ...patch.config } } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.managedByEnv !== undefined ? { managedByEnv: patch.managedByEnv } : {}),
      };
      byId.set(id, next);
      return next;
    },
    async delete(id) {
      validateIdentityLinkId(id);
      if (identityCount(id) > 0) {
        throw new ConflictError("provider is still used by identities");
      }
      byId.delete(id);
    },
  };
}

function createMemoryAccountRepo(ids: () => string): AccountRepo {
  const byId = new Map<string, Account>();

  return {
    async create(input) {
      const account: Account = {
        id: ids(),
        displayName: input.displayName,
        createdAt: new Date(),
        isAdmin: false,
      };
      byId.set(account.id, account);
      return account;
    },
    async get(id) {
      return byId.get(id) ?? null;
    },
    async setAdmin(id, isAdmin) {
      const existing = byId.get(id);
      if (!existing) {
        return;
      }
      byId.set(id, { ...existing, isAdmin });
    },
  };
}

function createMemoryIdentityRepo(ids: () => string): IdentityRepo & {
  countByProviderSync(providerId: string): number;
} {
  const byId = new Map<string, Identity>();

  function findByProviderUsername(providerId: string, username: string): Identity | null {
    for (const identity of byId.values()) {
      if (identity.providerId === providerId && identity.externalUsername === username) {
        return identity;
      }
    }
    return null;
  }

  return {
    async findByProviderUsername(providerId, username) {
      return findByProviderUsername(providerId, username);
    },
    async create(input) {
      const existing = findByProviderUsername(input.providerId, input.externalUsername);
      if (existing) {
        throw new Error(
          `identity already exists for provider ${input.providerId} and username ${input.externalUsername}`,
        );
      }
      const identity: Identity = {
        id: ids(),
        accountId: input.accountId,
        providerId: input.providerId,
        externalUsername: input.externalUsername,
        createdAt: new Date(),
        lastLoginAt: null,
      };
      byId.set(identity.id, identity);
      return identity;
    },
    async get(id) {
      return byId.get(id) ?? null;
    },
    async listByAccount(accountId) {
      return Array.from(byId.values()).filter((identity) => identity.accountId === accountId);
    },
    countByProviderSync(providerId) {
      return Array.from(byId.values()).filter((identity) => identity.providerId === providerId)
        .length;
    },
    async countByProvider(providerId) {
      return Array.from(byId.values()).filter((identity) => identity.providerId === providerId)
        .length;
    },
    async touchLogin(id, at) {
      const existing = byId.get(id);
      if (!existing) {
        return;
      }
      byId.set(id, { ...existing, lastLoginAt: at });
    },
    async listAll() {
      return Array.from(byId.values());
    },
  };
}

function createMemoryCredentialRepo(): CredentialRepo {
  const byIdentityId = new Map<string, Credential>();

  return {
    async put(input) {
      const existing = byIdentityId.get(input.identityId);
      byIdentityId.set(input.identityId, {
        identityId: input.identityId,
        ciphertext: input.ciphertext,
        keyId: input.keyId,
        cachedToken: existing?.cachedToken ?? null,
        cachedTokenExpiresAt: existing?.cachedTokenExpiresAt ?? null,
        updatedAt: new Date(),
      });
    },
    async get(identityId) {
      return byIdentityId.get(identityId) ?? null;
    },
    async setCachedToken(identityId, token) {
      const existing = byIdentityId.get(identityId);
      if (!existing) {
        return;
      }
      byIdentityId.set(identityId, {
        ...existing,
        cachedToken: token?.sealed ?? null,
        cachedTokenExpiresAt: token?.expiresAt ?? null,
        updatedAt: new Date(),
      });
    },
  };
}

function createMemorySessionRepo(): SessionRepo {
  const byIdHash = new Map<string, Session>();

  return {
    // Identity-operation fixtures may copy an existing login without resetting its age.
    async create(
      input: Parameters<SessionRepo["create"]>[0] &
        Partial<Pick<Session, "createdAt" | "lastSeenAt">>,
    ) {
      const session: Session = {
        idHash: input.idHash,
        accountId: input.accountId,
        activeIdentityId: input.activeIdentityId,
        createdAt: input.createdAt ?? new Date(),
        expiresAt: input.expiresAt,
        lastSeenAt: input.lastSeenAt ?? new Date(),
        userAgent: input.userAgent,
        ip: input.ip,
      };
      byIdHash.set(session.idHash, session);
      return session;
    },
    async getByIdHash(idHash, now) {
      const session = byIdHash.get(idHash);
      if (!session) {
        return null;
      }
      if (session.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      return session;
    },
    async touch(idHash, input) {
      const existing = byIdHash.get(idHash);
      if (!existing) {
        return;
      }
      byIdHash.set(idHash, {
        ...existing,
        lastSeenAt: input.lastSeenAt,
        expiresAt: input.expiresAt,
      });
    },
    async delete(idHash) {
      byIdHash.delete(idHash);
    },
    async deleteExpired(now) {
      let count = 0;
      for (const [idHash, session] of byIdHash.entries()) {
        if (session.expiresAt.getTime() <= now.getTime()) {
          byIdHash.delete(idHash);
          count += 1;
        }
      }
      return count;
    },
  };
}

function createMemoryApiTokenRepo(ids: () => string): ApiTokenRepo {
  const byId = new Map<string, ApiToken>();

  return {
    async create(input) {
      const token: ApiToken = {
        id: ids(),
        accountId: input.accountId,
        identityId: input.identityId,
        name: input.name,
        tokenHash: input.tokenHash,
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt: input.expiresAt,
      };
      byId.set(token.id, token);
      return token;
    },
    async findByHash(hash) {
      for (const token of byId.values()) {
        if (token.tokenHash === hash) {
          return token;
        }
      }
      return null;
    },
    async listByAccount(accountId) {
      return Array.from(byId.values()).filter((token) => token.accountId === accountId);
    },
    async touch(id, at) {
      const existing = byId.get(id);
      if (!existing) {
        return;
      }
      byId.set(id, { ...existing, lastUsedAt: at });
    },
    async delete(id, accountId) {
      const existing = byId.get(id);
      if (existing && existing.accountId === accountId) {
        byId.delete(id);
      }
    },
  };
}

function createMemorySettingsRepo(): SettingsRepo {
  const byKey = new Map<string, unknown>();

  return {
    async get<T>(key: string) {
      return byKey.has(key) ? (byKey.get(key) as T) : null;
    },
    async set(key, value) {
      byKey.set(key, value);
    },
    async compareAndSet(key, expected, value) {
      const current = byKey.has(key) ? byKey.get(key) : null;
      if (!isDeepStrictEqual(current, expected)) {
        return false;
      }
      byKey.set(key, value);
      return true;
    },
    async all() {
      return Object.fromEntries(byKey.entries());
    },
  };
}

/** True when `path` is `target` itself, or (when `isDir`) nested under it. */
function matchesPrefix(path: string, target: string, isDir: boolean): boolean {
  return path === target || (isDir && path.startsWith(`${target}/`));
}

/** Rewrites `path` (known to match `matchesPrefix(path, oldPath, ...)`) onto `newPath`. */
function rewritePrefix(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : newPath + path.slice(oldPath.length);
}

function createMemoryTagRepo(ids: () => string, onDeleted: (tagId: string) => void): TagRepo {
  const byId = new Map<string, Tag>();

  function findByName(accountId: string, name: string, excludeId?: string): Tag | undefined {
    for (const tag of byId.values()) {
      if (tag.accountId === accountId && tag.name === name && tag.id !== excludeId) {
        return tag;
      }
    }
    return undefined;
  }

  return {
    async list(accountId) {
      return Array.from(byId.values()).filter((tag) => tag.accountId === accountId);
    },
    async create(accountId, input) {
      if (findByName(accountId, input.name) !== undefined) {
        throw new ConflictError(`tag name already exists: ${input.name}`);
      }
      const tag: Tag = { id: ids(), accountId, name: input.name, color: input.color };
      byId.set(tag.id, tag);
      return tag;
    },
    async update(id, accountId, patch) {
      const existing = byId.get(id);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      if (patch.name !== undefined && findByName(accountId, patch.name, id) !== undefined) {
        throw new ConflictError(`tag name already exists: ${patch.name}`);
      }
      const updated: Tag = {
        ...existing,
        name: patch.name ?? existing.name,
        color: patch.color !== undefined ? patch.color : existing.color,
      };
      byId.set(id, updated);
      return updated;
    },
    async delete(id, accountId) {
      const existing = byId.get(id);
      if (existing && existing.accountId === accountId) {
        byId.delete(id);
        onDeleted(id);
      }
    },
  };
}

interface MemoryFileTagRepo extends FileTagRepo {
  /** Removes `tagId` from every path it is assigned to, across every identity. */
  removeTag(tagId: string): void;
  snapshot(identityId: string): Map<string, Set<string>> | undefined;
  restore(identityId: string, snapshot: Map<string, Set<string>> | undefined): void;
}

function createMemoryFileTagRepo(): MemoryFileTagRepo {
  const byIdentity = new Map<string, Map<string, Set<string>>>();

  function pathsFor(identityId: string): Map<string, Set<string>> {
    let existing = byIdentity.get(identityId);
    if (!existing) {
      existing = new Map();
      byIdentity.set(identityId, existing);
    }
    return existing;
  }

  return {
    async tagsForPaths(identityId, paths) {
      const result = new Map<string, string[]>();
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return result;
      }
      for (const path of paths) {
        const tagIds = byPath.get(path);
        if (tagIds && tagIds.size > 0) {
          result.set(path, Array.from(tagIds));
        }
      }
      return result;
    },
    async setTags(identityId, path, tagIds) {
      const byPath = pathsFor(identityId);
      if (tagIds.length === 0) {
        byPath.delete(path);
      } else {
        byPath.set(path, new Set(tagIds));
      }
    },
    async pathsForTag(identityId, tagId) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return [];
      }
      const result: string[] = [];
      for (const [path, tagIds] of byPath) {
        if (tagIds.has(tagId)) {
          result.push(path);
        }
      }
      return result;
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      const moved: [string, Set<string>][] = [];
      for (const [path, tagIds] of byPath) {
        if (matchesPrefix(path, oldPath, isDir)) {
          moved.push([rewritePrefix(path, oldPath, newPath), tagIds]);
        }
      }
      for (const path of Array.from(byPath.keys())) {
        if (matchesPrefix(path, oldPath, isDir)) {
          byPath.delete(path);
        }
      }
      for (const [path, tagIds] of moved) {
        byPath.set(path, tagIds);
      }
    },
    async deletePrefix(identityId, path, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      for (const existingPath of Array.from(byPath.keys())) {
        if (matchesPrefix(existingPath, path, isDir)) {
          byPath.delete(existingPath);
        }
      }
    },
    removeTag(tagId) {
      for (const byPath of byIdentity.values()) {
        for (const [path, tagIds] of byPath) {
          tagIds.delete(tagId);
          if (tagIds.size === 0) {
            byPath.delete(path);
          }
        }
      }
    },
    snapshot(identityId) {
      const byPath = byIdentity.get(identityId);
      return byPath === undefined
        ? undefined
        : new Map([...byPath].map(([path, tagIds]) => [path, new Set(tagIds)]));
    },
    restore(identityId, snapshot) {
      if (snapshot === undefined) byIdentity.delete(identityId);
      else byIdentity.set(identityId, snapshot);
    },
  };
}

interface MemoryFavoriteRepo extends FavoriteRepo {
  snapshot(identityId: string): Map<string, Favorite> | undefined;
  restore(identityId: string, snapshot: Map<string, Favorite> | undefined): void;
}

function createMemoryFavoriteRepo(): MemoryFavoriteRepo {
  const byIdentity = new Map<string, Map<string, Favorite>>();

  function favoritesFor(identityId: string): Map<string, Favorite> {
    let existing = byIdentity.get(identityId);
    if (!existing) {
      existing = new Map();
      byIdentity.set(identityId, existing);
    }
    return existing;
  }

  return {
    async list(identityId) {
      const byPath = byIdentity.get(identityId);
      return byPath ? Array.from(byPath.values()) : [];
    },
    async add(identityId, path, kind: FavoriteKind) {
      const byPath = favoritesFor(identityId);
      const existing = byPath.get(path);
      byPath.set(path, { identityId, path, kind, createdAt: existing?.createdAt ?? new Date() });
    },
    async remove(identityId, path) {
      byIdentity.get(identityId)?.delete(path);
    },
    async has(identityId, paths) {
      const byPath = byIdentity.get(identityId);
      const result = new Set<string>();
      if (!byPath) {
        return result;
      }
      for (const path of paths) {
        if (byPath.has(path)) {
          result.add(path);
        }
      }
      return result;
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      const moved: Favorite[] = [];
      for (const [path, favorite] of byPath) {
        if (matchesPrefix(path, oldPath, isDir)) {
          moved.push({ ...favorite, path: rewritePrefix(path, oldPath, newPath) });
        }
      }
      for (const path of Array.from(byPath.keys())) {
        if (matchesPrefix(path, oldPath, isDir)) {
          byPath.delete(path);
        }
      }
      for (const favorite of moved) {
        byPath.set(favorite.path, favorite);
      }
    },
    async deletePrefix(identityId, path, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      for (const existingPath of Array.from(byPath.keys())) {
        if (matchesPrefix(existingPath, path, isDir)) {
          byPath.delete(existingPath);
        }
      }
    },
    snapshot(identityId) {
      const byPath = byIdentity.get(identityId);
      return byPath === undefined
        ? undefined
        : new Map([...byPath].map(([path, favorite]) => [path, { ...favorite }]));
    },
    restore(identityId, snapshot) {
      if (snapshot === undefined) byIdentity.delete(identityId);
      else byIdentity.set(identityId, snapshot);
    },
  };
}

interface MemoryFolderViewRepo extends FolderViewRepo {
  snapshot(identityId: string): Map<string, FolderView> | undefined;
  restore(identityId: string, snapshot: Map<string, FolderView> | undefined): void;
}

function createMemoryFolderViewRepo(): MemoryFolderViewRepo {
  const byIdentity = new Map<string, Map<string, FolderView>>();

  function viewsFor(identityId: string): Map<string, FolderView> {
    let existing = byIdentity.get(identityId);
    if (!existing) {
      existing = new Map();
      byIdentity.set(identityId, existing);
    }
    return existing;
  }

  return {
    async get(identityId, path) {
      return byIdentity.get(identityId)?.get(path) ?? null;
    },
    async set(identityId, path, mode: FolderViewMode, sort?: FolderViewSort | null) {
      const existing = viewsFor(identityId).get(path);
      viewsFor(identityId).set(path, {
        identityId,
        path,
        mode,
        sort: sort === undefined ? (existing?.sort ?? null) : sort,
        updatedAt: new Date(),
      });
    },
    async remove(identityId, path) {
      byIdentity.get(identityId)?.delete(path);
    },
    async clear(identityId) {
      byIdentity.delete(identityId);
    },
    async has(identityId, path) {
      return byIdentity.get(identityId)?.has(path) ?? false;
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) return;
      const moved: FolderView[] = [];
      for (const [path, view] of byPath) {
        if (matchesPrefix(path, oldPath, isDir)) {
          moved.push({
            ...view,
            path: rewritePrefix(path, oldPath, newPath),
            updatedAt: new Date(),
          });
        }
      }
      for (const path of Array.from(byPath.keys())) {
        if (matchesPrefix(path, oldPath, isDir)) byPath.delete(path);
      }
      for (const view of moved) byPath.set(view.path, view);
    },
    async deletePrefix(identityId, path, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) return;
      for (const existingPath of Array.from(byPath.keys())) {
        if (matchesPrefix(existingPath, path, isDir)) byPath.delete(existingPath);
      }
    },
    snapshot(identityId) {
      const byPath = byIdentity.get(identityId);
      return byPath === undefined
        ? undefined
        : new Map(
            [...byPath].map(([path, view]) => [
              path,
              { ...view, sort: view.sort === null ? null : { ...view.sort } },
            ]),
          );
    },
    restore(identityId, snapshot) {
      if (snapshot === undefined) byIdentity.delete(identityId);
      else byIdentity.set(identityId, snapshot);
    },
  };
}

interface MemoryRecentRepo extends RecentRepo {
  snapshot(identityId: string): Map<string, Recent> | undefined;
  restore(identityId: string, snapshot: Map<string, Recent> | undefined): void;
}

function createMemoryRecentRepo(): MemoryRecentRepo {
  const byIdentity = new Map<string, Map<string, Recent>>();

  function recentsFor(identityId: string): Map<string, Recent> {
    let existing = byIdentity.get(identityId);
    if (!existing) {
      existing = new Map();
      byIdentity.set(identityId, existing);
    }
    return existing;
  }

  return {
    async list(identityId, limit) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return [];
      }
      return Array.from(byPath.values())
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
        .slice(0, limit);
    },
    async touch(identityId, path) {
      recentsFor(identityId).set(path, { identityId, path, openedAt: new Date() });
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      const moved: Recent[] = [];
      for (const [path, recent] of byPath) {
        if (matchesPrefix(path, oldPath, isDir)) {
          moved.push({ ...recent, path: rewritePrefix(path, oldPath, newPath) });
        }
      }
      for (const path of Array.from(byPath.keys())) {
        if (matchesPrefix(path, oldPath, isDir)) {
          byPath.delete(path);
        }
      }
      for (const recent of moved) {
        byPath.set(recent.path, recent);
      }
    },
    async deletePrefix(identityId, path, isDir) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      for (const existingPath of Array.from(byPath.keys())) {
        if (matchesPrefix(existingPath, path, isDir)) {
          byPath.delete(existingPath);
        }
      }
    },
    async prune(identityId, keep) {
      const byPath = byIdentity.get(identityId);
      if (!byPath) {
        return;
      }
      const sorted = Array.from(byPath.values()).sort(
        (a, b) => b.openedAt.getTime() - a.openedAt.getTime(),
      );
      for (const recent of sorted.slice(keep)) {
        byPath.delete(recent.path);
      }
    },
    snapshot(identityId) {
      const byPath = byIdentity.get(identityId);
      return byPath === undefined
        ? undefined
        : new Map(
            [...byPath].map(([path, recent]) => [
              path,
              { ...recent, openedAt: new Date(recent.openedAt) },
            ]),
          );
    },
    restore(identityId, snapshot) {
      if (snapshot === undefined) byIdentity.delete(identityId);
      else byIdentity.set(identityId, snapshot);
    },
  };
}

function createMemoryMetadataPathRepo(repos: {
  fileTags: MemoryFileTagRepo;
  favorites: MemoryFavoriteRepo;
  folderViews: MemoryFolderViewRepo;
  recents: MemoryRecentRepo;
}): MetadataPathRepo {
  const tails = new Map<string, Promise<void>>();

  async function atomic(identityId: string, operation: () => Promise<void>): Promise<void> {
    const previous = tails.get(identityId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(identityId, current);
    await previous;

    const snapshots = {
      fileTags: repos.fileTags.snapshot(identityId),
      favorites: repos.favorites.snapshot(identityId),
      folderViews: repos.folderViews.snapshot(identityId),
      recents: repos.recents.snapshot(identityId),
    };
    try {
      await operation();
    } catch (error) {
      repos.fileTags.restore(identityId, snapshots.fileTags);
      repos.favorites.restore(identityId, snapshots.favorites);
      repos.folderViews.restore(identityId, snapshots.folderViews);
      repos.recents.restore(identityId, snapshots.recents);
      throw error;
    } finally {
      release();
      if (tails.get(identityId) === current) tails.delete(identityId);
    }
  }

  return {
    movePrefix(identityId, oldPath, newPath, isDir) {
      if (oldPath === newPath) return Promise.resolve();
      return atomic(identityId, async () => {
        // These in-memory methods mutate synchronously before returning their
        // promises. Invoke every one in this turn so a microtask reader cannot
        // observe a successful operation between table updates.
        await Promise.all([
          repos.fileTags.movePrefix(identityId, oldPath, newPath, isDir),
          repos.favorites.movePrefix(identityId, oldPath, newPath, isDir),
          repos.folderViews.movePrefix(identityId, oldPath, newPath, isDir),
          repos.recents.movePrefix(identityId, oldPath, newPath, isDir),
        ]);
      });
    },
    deletePrefix(identityId, path, isDir) {
      return atomic(identityId, async () => {
        await Promise.all([
          repos.fileTags.deletePrefix(identityId, path, isDir),
          repos.favorites.deletePrefix(identityId, path, isDir),
          repos.folderViews.deletePrefix(identityId, path, isDir),
          repos.recents.deletePrefix(identityId, path, isDir),
        ]);
      });
    },
  };
}

/**
 * The in-memory event log. Only the API's own entries exist here: the
 * sidecar history the Drizzle implementation merges in lives in the
 * indexer's Postgres tables, which have no in-memory counterpart.
 */
function createMemorySystemEventRepo(): SystemEventRepo {
  const bySubsystem = new Map<string, SystemEvent[]>();
  let nextId = 0;

  return {
    async append(input) {
      nextId += 1;
      const entries = bySubsystem.get(input.subsystem) ?? [];
      entries.push({
        id: `api:${nextId}`,
        at: new Date(),
        subsystem: input.subsystem,
        level: input.level,
        message: input.message,
        data: input.data ?? null,
        source: "api",
      });
      bySubsystem.set(input.subsystem, entries);
    },
    async list(subsystem, opts) {
      const levels = levelsAtLeast(opts.minLevel);
      const entries = bySubsystem.get(subsystem) ?? [];
      return entries
        .filter(
          (entry) =>
            levels.includes(entry.level) &&
            (opts.before === undefined || entry.at.getTime() < opts.before.getTime()),
        )
        .slice()
        .reverse()
        .slice(0, opts.limit);
    },
    async prune(subsystem, keep) {
      const entries = bySubsystem.get(subsystem);
      if (entries === undefined) {
        return;
      }
      bySubsystem.set(subsystem, entries.slice(Math.max(0, entries.length - keep)));
    },
  };
}

/**
 * In-memory implementations of every `Repos` interface, matching the
 * uniqueness and expiry semantics of the Drizzle-backed repositories.
 * Intended for fast unit tests; not shared across processes.
 */
export function createMemoryRepos(opts: CreateMemoryReposOptions = {}): Repos {
  const ids = opts.ids ?? randomUUID;
  const fileTags = createMemoryFileTagRepo();
  const favorites = createMemoryFavoriteRepo();
  const folderViews = createMemoryFolderViewRepo();
  const identities = createMemoryIdentityRepo(ids);
  const recents = createMemoryRecentRepo();

  return {
    providers: createMemoryProviderRepo(ids, (providerId) =>
      identities.countByProviderSync(providerId),
    ),
    accounts: createMemoryAccountRepo(ids),
    identities,
    credentials: createMemoryCredentialRepo(),
    sessions: createMemorySessionRepo(),
    settings: createMemorySettingsRepo(),
    apiTokens: createMemoryApiTokenRepo(ids),
    tags: createMemoryTagRepo(ids, (tagId) => fileTags.removeTag(tagId)),
    fileTags,
    favorites,
    folderViews,
    recents,
    metadataPaths: createMemoryMetadataPathRepo({ fileTags, favorites, folderViews, recents }),
    systemEvents: createMemorySystemEventRepo(),
  };
}
