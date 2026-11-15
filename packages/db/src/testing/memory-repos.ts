import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LoginError,
  type LoginRepo,
  type NewLocalUser,
  SETUP_OWNER_KEY,
  type SetupOwner,
  validateCanonicalUuid,
  validateNewLocalUser,
  validateSignIn,
} from "../repos/logins-types.js";
import type {
  Account,
  AccountRepo,
  AiChat,
  AiChatMessage,
  AiChatReference,
  AiChatRepo,
  ApiToken,
  ApiTokenRepo,
  Favorite,
  FavoriteKind,
  FavoriteRepo,
  FileTagRepo,
  FolderView,
  FolderViewPatch,
  FolderViewRepo,
  Identity,
  IdentityRepo,
  LocalGrant,
  LocalGrantRepo,
  LocalUser,
  LocalUserRepo,
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
      validateCanonicalUuid(id);
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
      validateCanonicalUuid(id);
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
      validateCanonicalUuid(id);
      if (identityCount(id) > 0) {
        throw new ConflictError("provider is still used by identities");
      }
      byId.delete(id);
    },
  };
}

function createMemoryLocalUserRepo(): LocalUserRepo & {
  /** For the login repo, the only way to create a user. */
  insert(input: { username: string; passwordHash: string; at: Date }): void;
} {
  const byName = new Map<string, LocalUser>();
  const key = (username: string) => username.toLowerCase();

  return {
    insert(input) {
      if (byName.has(key(input.username))) throw new ConflictError("username already exists");
      byName.set(key(input.username), {
        username: input.username,
        passwordHash: input.passwordHash,
        disabled: false,
        createdAt: input.at,
        updatedAt: input.at,
      });
    },
    async get(username) {
      return byName.get(key(username)) ?? null;
    },
    async list() {
      return [...byName.values()].sort((a, b) =>
        a.username < b.username ? -1 : a.username > b.username ? 1 : 0,
      );
    },
    async count() {
      return byName.size;
    },
    async update(username, patch) {
      const existing = byName.get(key(username));
      if (existing === undefined) return null;
      const updated: LocalUser = { ...existing, ...patch, updatedAt: new Date() };
      byName.set(key(username), updated);
      return updated;
    },
    async delete(username) {
      byName.delete(key(username));
    },
  };
}

function createMemoryLocalGrantRepo(
  ids: () => string,
  users: Pick<LocalUserRepo, "get">,
): LocalGrantRepo {
  const rows: LocalGrant[] = [];
  const atOrUnder = (path: string, prefix: string) =>
    path === prefix || path.startsWith(prefix === "/" ? "/" : `${prefix}/`);

  return {
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async listReceived(grantee) {
      const received: LocalGrant[] = [];
      for (const row of rows) {
        if (row.granteeUsername !== grantee) continue;
        if ((await users.get(row.ownerUsername))?.disabled === false) received.push(row);
      }
      return received;
    },
    async listOwned(owner, path) {
      return rows.filter(
        (row) => row.ownerUsername === owner && (path === undefined || row.path === path),
      );
    },
    async put(input) {
      const at = rows.findIndex(
        (row) =>
          row.ownerUsername === input.ownerUsername &&
          row.path === input.path &&
          row.granteeUsername === input.granteeUsername,
      );
      const existing = rows[at];
      if (existing !== undefined) {
        const updated = { ...existing, access: input.access };
        rows[at] = updated;
        return updated;
      }
      const created: LocalGrant = { id: ids(), ...input, createdAt: new Date() };
      rows.push(created);
      return created;
    },
    async delete(id) {
      const at = rows.findIndex((row) => row.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    async movePrefix(owner, from, to) {
      for (const [at, row] of rows.entries()) {
        if (row.ownerUsername === owner && atOrUnder(row.path, from)) {
          rows[at] = { ...row, path: `${to}${row.path.slice(from.length)}` };
        }
      }
    },
    async deletePrefix(owner, path) {
      for (let at = rows.length - 1; at >= 0; at -= 1) {
        const row = rows[at] as LocalGrant;
        if (row.ownerUsername === owner && atOrUnder(row.path, path)) rows.splice(at, 1);
      }
    },
  };
}

function createMemoryAccountRepo(ids: () => string): AccountRepo & {
  /** For the login repo: how many accounts exist. */
  countSync(): number;
} {
  const byId = new Map<string, Account>();

  return {
    countSync: () => byId.size,
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
  /** The login named `username` in any case, as the database's unique index finds it. */
  byName(username: string): Identity | null;
} {
  const byId = new Map<string, Identity>();

  function byName(username: string): Identity | null {
    const name = username.toLowerCase();
    for (const identity of byId.values()) {
      if (identity.externalUsername.toLowerCase() === name) return identity;
    }
    return null;
  }

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
    byName,
    async create(input) {
      // Unique in any case, as the database's index on the login's name is.
      const existing = byName(input.externalUsername);
      if (existing) {
        throw new Error(`a login named ${input.externalUsername} already exists`);
      }
      // One login per account, as the database's unique constraint enforces.
      if (Array.from(byId.values()).some((identity) => identity.accountId === input.accountId)) {
        throw new Error(`account ${input.accountId} already has a login`);
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

function createMemorySessionRepo(): SessionRepo {
  const byIdHash = new Map<string, Session>();

  return {
    // Sign-in fixtures pass the test clock's time as the session's age.
    async create(
      input: Parameters<SessionRepo["create"]>[0] &
        Partial<Pick<Session, "createdAt" | "lastSeenAt">>,
    ) {
      const session: Session = {
        idHash: input.idHash,
        accountId: input.accountId,
        identityId: input.identityId,
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
    async deleteByAccount(accountId, exceptIdHash) {
      let count = 0;
      for (const [idHash, session] of byIdHash.entries()) {
        if (session.accountId === accountId && idHash !== exceptIdHash) {
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
        ...(input.access === undefined ? {} : { access: structuredClone(input.access) }),
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
    async set(identityId, path, patch: FolderViewPatch) {
      if (patch.mode === undefined && patch.sort === undefined) return;
      const views = viewsFor(identityId);
      const existing = views.get(path);
      const mode = patch.mode === undefined ? (existing?.mode ?? null) : patch.mode;
      const sort = patch.sort === undefined ? (existing?.sort ?? null) : patch.sort;
      if (mode === null && sort === null) {
        views.delete(path);
        return;
      }
      views.set(path, { identityId, path, mode, sort, updatedAt: new Date() });
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
function createMemoryAiChatRepo(ids: () => string): AiChatRepo {
  const chats = new Map<string, AiChat>();
  const messages = new Map<string, AiChatMessage[]>();
  const references = new Map<string, Map<string, AiChatReference>>();
  // Activity order breaks ties between chats active in the same millisecond.
  const order = new Map<string, number>();
  let activity = 0;

  function owned(identityId: string, id: string): AiChat | null {
    const chat = chats.get(id);
    return chat !== undefined && chat.identityId === identityId ? chat : null;
  }
  function sorted(identityId: string): AiChat[] {
    return [...chats.values()]
      .filter((chat) => chat.identityId === identityId)
      .sort(
        (a, b) =>
          b.lastMessageAt.getTime() - a.lastMessageAt.getTime() ||
          (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
      );
  }
  function remove(id: string): void {
    chats.delete(id);
    order.delete(id);
    messages.delete(id);
    references.delete(id);
  }
  function movedPath(path: string, oldPath: string, newPath: string, isDir: boolean) {
    if (path === oldPath) return newPath;
    if (isDir && path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
    return null;
  }

  return {
    async create(input) {
      const now = new Date();
      const chat: AiChat = {
        id: ids(),
        identityId: input.identityId,
        title: input.title,
        share: { ...input.share },
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
      };
      chats.set(chat.id, chat);
      order.set(chat.id, ++activity);
      messages.set(chat.id, []);
      references.set(chat.id, new Map());
      return chat;
    },
    async get(identityId, id) {
      return owned(identityId, id);
    },
    async list(identityId, limit) {
      return sorted(identityId).slice(0, limit);
    },
    async rename(identityId, id, title) {
      const chat = owned(identityId, id);
      if (chat === null) return null;
      const renamed = { ...chat, title, updatedAt: new Date() };
      chats.set(id, renamed);
      return renamed;
    },
    async delete(identityId, id) {
      if (owned(identityId, id) === null) return false;
      remove(id);
      return true;
    },
    async prune(identityId, options) {
      const all = sorted(identityId);
      const gone = all.filter(
        (chat, index) => chat.lastMessageAt < options.idleBefore || index >= options.keep,
      );
      for (const chat of gone) remove(chat.id);
      return gone.length;
    },
    async messages(chatId) {
      return [...(messages.get(chatId) ?? [])];
    },
    async appendMessage(chatId, input) {
      const chat = chats.get(chatId);
      const list = messages.get(chatId);
      if (chat === undefined || list === undefined) throw new Error("chat does not exist");
      const now = new Date();
      const message: AiChatMessage = {
        id: ids(),
        chatId,
        ordinal: list.length === 0 ? 1 : (list[list.length - 1] as AiChatMessage).ordinal + 1,
        role: input.role,
        parts: [...input.parts],
        references: [...input.references],
        location: input.location,
        createdAt: now,
      };
      list.push(message);
      chats.set(chatId, { ...chat, lastMessageAt: now, updatedAt: now });
      order.set(chatId, ++activity);
      return message;
    },
    async updateMessageParts(messageId, parts) {
      for (const list of messages.values()) {
        const index = list.findIndex((message) => message.id === messageId);
        if (index >= 0) list[index] = { ...(list[index] as AiChatMessage), parts: [...parts] };
      }
    },
    async references(chatId) {
      return [...(references.get(chatId)?.values() ?? [])].sort(
        (a, b) => a.addedAt.getTime() - b.addedAt.getTime() || a.path.localeCompare(b.path),
      );
    },
    async addReferences(chatId, paths) {
      const refs = references.get(chatId);
      if (refs === undefined) throw new Error("chat does not exist");
      for (const path of paths) {
        const existing = refs.get(path);
        refs.set(
          path,
          existing === undefined
            ? { path, missing: false, addedAt: new Date() }
            : { ...existing, missing: false },
        );
      }
    },
    async moveReferences(identityId, oldPath, newPath, isDir) {
      if (oldPath === newPath) return;
      for (const chat of chats.values()) {
        if (chat.identityId !== identityId) continue;
        const refs = references.get(chat.id) ?? new Map<string, AiChatReference>();
        for (const ref of [...refs.values()]) {
          const target = movedPath(ref.path, oldPath, newPath, isDir);
          if (target === null) continue;
          refs.delete(ref.path);
          refs.set(target, { ...ref, path: target });
        }
      }
    },
    async markReferencesMissing(identityId, path, isDir) {
      for (const chat of chats.values()) {
        if (chat.identityId !== identityId) continue;
        for (const ref of references.get(chat.id)?.values() ?? [])
          if (ref.path === path || (isDir && ref.path.startsWith(`${path}/`)))
            references.get(chat.id)?.set(ref.path, { ...ref, missing: true });
      }
    },
  };
}

/**
 * The login repo over the other memory repos. Each call checks everything
 * that could refuse it before it writes, and calls run one at a time, so a
 * refused call leaves nothing behind, as the database's transactions do.
 */
function createMemoryLoginRepo(repos: {
  readonly localUsers: ReturnType<typeof createMemoryLocalUserRepo>;
  readonly accounts: ReturnType<typeof createMemoryAccountRepo>;
  readonly identities: ReturnType<typeof createMemoryIdentityRepo>;
  readonly sessions: SessionRepo;
  readonly settings: SettingsRepo;
}): LoginRepo {
  let tail: Promise<unknown> = Promise.resolve();
  function atomic<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  }

  /** The login a removed user of exactly this name left; `ConflictError` when the name is taken. */
  async function leftLogin(username: string): Promise<Identity | null> {
    const left = repos.identities.byName(username);
    if (
      (await repos.localUsers.get(username)) !== null ||
      (left !== null && left.externalUsername !== username)
    )
      throw new ConflictError("username already exists");
    return left;
  }

  async function insertUser(input: NewLocalUser, left: Identity | null): Promise<Identity> {
    repos.localUsers.insert({
      username: input.username,
      passwordHash: input.passwordHash,
      at: input.at,
    });
    if (left !== null) {
      await repos.accounts.setAdmin(left.accountId, input.isAdmin);
      return left;
    }
    const account = await repos.accounts.create({ displayName: input.username });
    await repos.accounts.setAdmin(account.id, input.isAdmin);
    return repos.identities.create({
      accountId: account.id,
      providerId: input.providerId,
      externalUsername: input.username,
    });
  }

  /** A fresh install: no owner record, no user, no account and no login. */
  async function isFresh(): Promise<boolean> {
    return (
      (await repos.settings.get(SETUP_OWNER_KEY)) === null &&
      (await repos.localUsers.count()) === 0 &&
      repos.accounts.countSync() === 0 &&
      (await repos.identities.listAll()).length === 0
    );
  }

  /** The user (matched in any case), their login and whether their account is an administrator's. */
  async function userWithLogin(username: string) {
    const user = await repos.localUsers.get(username);
    if (user === null) return null;
    const login = repos.identities.byName(user.username);
    if (login === null || login.externalUsername !== user.username)
      throw new LoginError("missing_identity");
    const isAdmin = (await repos.accounts.get(login.accountId))?.isAdmin === true;
    return { user, login, isAdmin };
  }

  async function enabledAdmins(): Promise<number> {
    let count = 0;
    for (const user of await repos.localUsers.list()) {
      const login = repos.identities.byName(user.username);
      if (user.disabled || login === null || login.externalUsername !== user.username) continue;
      if ((await repos.accounts.get(login.accountId))?.isAdmin === true) count += 1;
    }
    return count;
  }

  return {
    async createUser(input) {
      validateNewLocalUser(input);
      return atomic(async () => insertUser(input, await leftLogin(input.username)));
    },
    async setup(input) {
      validateNewLocalUser(input);
      return atomic(async () => {
        if (!(await isFresh())) throw new LoginError("setup_claimed");
        // Always a new account and login, never one left behind.
        const identity = await insertUser({ ...input, isAdmin: true }, null);
        const owner: SetupOwner = { state: "complete", accountId: identity.accountId };
        await repos.settings.set(SETUP_OWNER_KEY, owner);
        return identity;
      });
    },
    setupOpen: () => atomic(isFresh),
    updateUser(username, patch) {
      return atomic(async () => {
        const found = await userWithLogin(username);
        if (found === null) return null;
        const wasAdmin = found.isAdmin && !found.user.disabled;
        const staysAdmin =
          (patch.isAdmin ?? found.isAdmin) && !(patch.disabled ?? found.user.disabled);
        if (wasAdmin && !staysAdmin && (await enabledAdmins()) <= 1)
          throw new LoginError("last_admin");
        const user =
          (await repos.localUsers.update(found.user.username, {
            ...(patch.passwordHash === undefined ? {} : { passwordHash: patch.passwordHash }),
            ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
          })) ?? found.user;
        if (patch.isAdmin !== undefined)
          await repos.accounts.setAdmin(found.login.accountId, patch.isAdmin);
        return { user, login: found.login };
      });
    },
    removeUser(username) {
      return atomic(async () => {
        const found = await userWithLogin(username);
        if (found === null) return null;
        if (found.isAdmin && !found.user.disabled && (await enabledAdmins()) <= 1)
          throw new LoginError("last_admin");
        await repos.localUsers.delete(found.user.username);
        await repos.accounts.setAdmin(found.login.accountId, false);
        return found.login;
      });
    },
    async signIn(input) {
      validateSignIn(input);
      return atomic(async () => {
        const found = repos.identities.byName(input.username);
        if (found === null) throw new LoginError("missing_identity");
        await repos.identities.touchLogin(found.id, input.at);
        const session = await repos.sessions.create({
          ...input.session,
          accountId: found.accountId,
          identityId: found.id,
          // Kept as given, so the session's age is the caller's clock, as the
          // database's transaction writes it.
          createdAt: input.at,
          lastSeenAt: input.at,
        } as Parameters<SessionRepo["create"]>[0]);
        return { identity: { ...found, lastLoginAt: input.at }, session };
      });
    },
  };
}

export function createMemoryRepos(opts: CreateMemoryReposOptions = {}): Repos {
  const ids = opts.ids ?? randomUUID;
  const fileTags = createMemoryFileTagRepo();
  const favorites = createMemoryFavoriteRepo();
  const folderViews = createMemoryFolderViewRepo();
  const identities = createMemoryIdentityRepo(ids);
  const recents = createMemoryRecentRepo();
  const localUsers = createMemoryLocalUserRepo();
  const accounts = createMemoryAccountRepo(ids);
  const sessions = createMemorySessionRepo();
  const settings = createMemorySettingsRepo();

  return {
    providers: createMemoryProviderRepo(ids, (providerId) =>
      identities.countByProviderSync(providerId),
    ),
    localUsers,
    localGrants: createMemoryLocalGrantRepo(ids, localUsers),
    accounts,
    identities,
    logins: createMemoryLoginRepo({ localUsers, accounts, identities, sessions, settings }),
    sessions,
    settings,
    apiTokens: createMemoryApiTokenRepo(ids),
    tags: createMemoryTagRepo(ids, (tagId) => fileTags.removeTag(tagId)),
    fileTags,
    favorites,
    folderViews,
    recents,
    metadataPaths: createMemoryMetadataPathRepo({ fileTags, favorites, folderViews, recents }),
    systemEvents: createMemorySystemEventRepo(),
    aiChats: createMemoryAiChatRepo(ids),
  };
}
