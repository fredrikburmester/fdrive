import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  accounts,
  apiTokens,
  credentials,
  favorites,
  fileTags,
  identities,
  providers,
  recents,
  sessions,
  settings,
  tags,
} from "../schema/app.js";
import { validateIdentityLinkId } from "./identity-links-types.js";
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
  Identity,
  IdentityRepo,
  Provider,
  ProviderRepo,
  Recent,
  RecentRepo,
  Repos,
  Session,
  SessionRepo,
  SettingsRepo,
  Tag,
  TagRepo,
} from "./types.js";
import { ConflictError } from "./types.js";

/** The Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = "23505";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * True when `error` is a Postgres unique-constraint violation. node-postgres
 * throws the raw driver error with `.code` set directly, but Drizzle wraps
 * it in its own `DrizzleQueryError` with the driver error attached as
 * `.cause`, so both shapes are checked.
 */
function isUniqueViolation(error: unknown): boolean {
  if (hasCode(error, UNIQUE_VIOLATION_CODE)) {
    return true;
  }
  const cause =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return hasCode(cause, UNIQUE_VIOLATION_CODE);
}

function toProvider(row: typeof providers.$inferSelect): Provider {
  return { id: row.id, type: row.type, baseUrl: row.baseUrl, createdAt: row.createdAt };
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    displayName: row.displayName,
    createdAt: row.createdAt,
    isAdmin: row.isAdmin,
  };
}

function toIdentity(row: typeof identities.$inferSelect): Identity {
  return {
    id: row.id,
    accountId: row.accountId,
    providerId: row.providerId,
    externalUsername: row.externalUsername,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

function toCredential(row: typeof credentials.$inferSelect): Credential {
  return {
    identityId: row.identityId,
    ciphertext: new Uint8Array(row.ciphertext),
    keyId: row.keyId,
    cachedToken: row.cachedToken,
    cachedTokenExpiresAt: row.cachedTokenExpiresAt,
    updatedAt: row.updatedAt,
  };
}

function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    idHash: row.idHash,
    accountId: row.accountId,
    activeIdentityId: row.activeIdentityId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    userAgent: row.userAgent,
    ip: row.ip,
  };
}

function createProviderRepo(db: Db): ProviderRepo {
  return {
    async get(id) {
      validateIdentityLinkId(id);
      const [row] = await db.select().from(providers).where(eq(providers.id, id));
      return row ? toProvider(row) : null;
    },
    async ensure(input) {
      const [row] = await db
        .insert(providers)
        .values({ type: input.type, baseUrl: input.baseUrl })
        .onConflictDoUpdate({
          target: [providers.type, providers.baseUrl],
          set: { baseUrl: sql`excluded.base_url` },
        })
        .returning();
      if (!row) {
        throw new Error("providers.ensure: insert returned no row");
      }
      return toProvider(row);
    },
  };
}

function createAccountRepo(db: Db): AccountRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(accounts)
        .values({ displayName: input.displayName })
        .returning();
      if (!row) {
        throw new Error("accounts.create: insert returned no row");
      }
      return toAccount(row);
    },
    async get(id) {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
      return row ? toAccount(row) : null;
    },
    async setAdmin(id, isAdmin) {
      await db.update(accounts).set({ isAdmin }).where(eq(accounts.id, id));
    },
  };
}

function createIdentityRepo(db: Db): IdentityRepo {
  return {
    async findByProviderUsername(providerId, username) {
      const [row] = await db
        .select()
        .from(identities)
        .where(
          and(eq(identities.providerId, providerId), eq(identities.externalUsername, username)),
        );
      return row ? toIdentity(row) : null;
    },
    async create(input) {
      const [row] = await db
        .insert(identities)
        .values({
          accountId: input.accountId,
          providerId: input.providerId,
          externalUsername: input.externalUsername,
        })
        .returning();
      if (!row) {
        throw new Error("identities.create: insert returned no row");
      }
      return toIdentity(row);
    },
    async get(id) {
      const [row] = await db.select().from(identities).where(eq(identities.id, id));
      return row ? toIdentity(row) : null;
    },
    async listByAccount(accountId) {
      const rows = await db.select().from(identities).where(eq(identities.accountId, accountId));
      return rows.map(toIdentity);
    },
    async touchLogin(id, at) {
      await db.update(identities).set({ lastLoginAt: at }).where(eq(identities.id, id));
    },
    async listAll() {
      const rows = await db.select().from(identities);
      return rows.map(toIdentity);
    },
  };
}

function createCredentialRepo(db: Db): CredentialRepo {
  return {
    async put(input) {
      await db
        .insert(credentials)
        .values({
          identityId: input.identityId,
          ciphertext: Buffer.from(input.ciphertext),
          keyId: input.keyId,
        })
        .onConflictDoUpdate({
          target: credentials.identityId,
          set: {
            ciphertext: Buffer.from(input.ciphertext),
            keyId: input.keyId,
            updatedAt: new Date(),
          },
        });
    },
    async get(identityId) {
      const [row] = await db
        .select()
        .from(credentials)
        .where(eq(credentials.identityId, identityId));
      return row ? toCredential(row) : null;
    },
    async setCachedToken(identityId, token) {
      await db
        .update(credentials)
        .set({
          cachedToken: token?.sealed ?? null,
          cachedTokenExpiresAt: token?.expiresAt ?? null,
          updatedAt: new Date(),
        })
        .where(eq(credentials.identityId, identityId));
    },
  };
}

function createSessionRepo(db: Db): SessionRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(sessions)
        .values({
          idHash: input.idHash,
          accountId: input.accountId,
          activeIdentityId: input.activeIdentityId,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent,
          ip: input.ip,
        })
        .returning();
      if (!row) {
        throw new Error("sessions.create: insert returned no row");
      }
      return toSession(row);
    },
    async getByIdHash(idHash, now) {
      const [row] = await db.select().from(sessions).where(eq(sessions.idHash, idHash));
      if (!row) {
        return null;
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      return toSession(row);
    },
    async touch(idHash, input) {
      await db
        .update(sessions)
        .set({ lastSeenAt: input.lastSeenAt, expiresAt: input.expiresAt })
        .where(eq(sessions.idHash, idHash));
    },
    async delete(idHash) {
      await db.delete(sessions).where(eq(sessions.idHash, idHash));
    },
    async deleteExpired(now) {
      const deleted = await db.delete(sessions).where(lte(sessions.expiresAt, now)).returning();
      return deleted.length;
    },
  };
}

function toApiToken(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    accountId: row.accountId,
    identityId: row.identityId,
    name: row.name,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
  };
}

function createApiTokenRepo(db: Db): ApiTokenRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(apiTokens)
        .values({
          accountId: input.accountId,
          identityId: input.identityId,
          name: input.name,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) {
        throw new Error("apiTokens.create: insert returned no row");
      }
      return toApiToken(row);
    },
    async findByHash(hash) {
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash));
      return row ? toApiToken(row) : null;
    },
    async listByAccount(accountId) {
      const rows = await db.select().from(apiTokens).where(eq(apiTokens.accountId, accountId));
      return rows.map(toApiToken);
    },
    async touch(id, at) {
      await db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id));
    },
    async delete(id, accountId) {
      await db
        .delete(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.accountId, accountId)));
    },
  };
}

function createSettingsRepo(db: Db): SettingsRepo {
  return {
    async get<T>(key: string) {
      const [row] = await db.select().from(settings).where(eq(settings.key, key));
      return row ? (row.value as T) : null;
    },
    async set(key, value) {
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        });
    },
    async all() {
      const rows = await db.select().from(settings);
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    },
  };
}

function toTag(row: typeof tags.$inferSelect): Tag {
  return { id: row.id, accountId: row.accountId, name: row.name, color: row.color };
}

function createTagRepo(db: Db): TagRepo {
  return {
    async list(accountId) {
      const rows = await db.select().from(tags).where(eq(tags.accountId, accountId));
      return rows.map(toTag);
    },
    async create(accountId, input) {
      try {
        const [row] = await db
          .insert(tags)
          .values({ accountId, name: input.name, color: input.color })
          .returning();
        if (!row) {
          throw new Error("tags.create: insert returned no row");
        }
        return toTag(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(`tag name already exists: ${input.name}`);
        }
        throw error;
      }
    },
    async update(id, accountId, patch) {
      try {
        const [row] = await db
          .update(tags)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {}),
          })
          .where(and(eq(tags.id, id), eq(tags.accountId, accountId)))
          .returning();
        return row ? toTag(row) : null;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(`tag name already exists: ${patch.name ?? ""}`);
        }
        throw error;
      }
    },
    async delete(id, accountId) {
      await db.delete(tags).where(and(eq(tags.id, id), eq(tags.accountId, accountId)));
    },
  };
}

function createFileTagRepo(db: Db): FileTagRepo {
  return {
    async tagsForPaths(identityId, paths) {
      const result = new Map<string, string[]>();
      if (paths.length === 0) {
        return result;
      }
      const rows = await db
        .select({ path: fileTags.path, tagId: fileTags.tagId })
        .from(fileTags)
        .where(and(eq(fileTags.identityId, identityId), inArray(fileTags.path, [...paths])));
      for (const row of rows) {
        const existing = result.get(row.path);
        if (existing) {
          existing.push(row.tagId);
        } else {
          result.set(row.path, [row.tagId]);
        }
      }
      return result;
    },
    async setTags(identityId, path, tagIds) {
      await db.transaction(async (tx) => {
        await tx
          .delete(fileTags)
          .where(and(eq(fileTags.identityId, identityId), eq(fileTags.path, path)));
        if (tagIds.length > 0) {
          await tx
            .insert(fileTags)
            .values(tagIds.map((tagId) => ({ identityId, path, tagId })))
            .onConflictDoNothing();
        }
      });
    },
    async pathsForTag(identityId, tagId) {
      const rows = await db
        .select({ path: fileTags.path })
        .from(fileTags)
        .where(and(eq(fileTags.identityId, identityId), eq(fileTags.tagId, tagId)));
      return rows.map((row) => row.path);
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          delete from "app"."file_tags" f
          using "app"."file_tags" s
          where f.identity_id = ${identityId} and s.identity_id = ${identityId}
            and f.path <> s.path
            and (
              (s.path = ${oldPath} and f.path = ${newPath})
              or (${isDir} and s.path like ${`${oldPrefix}%`} and f.path = ${newPrefix} || substr(s.path, ${oldPrefix.length + 1}))
            )
        `);
        await tx.execute(sql`
          update "app"."file_tags"
          set path = case when path = ${oldPath} then ${newPath}
                          else ${newPrefix} || substr(path, ${oldPrefix.length + 1}) end
          where identity_id = ${identityId}
            and (path = ${oldPath} or (${isDir} and path like ${`${oldPrefix}%`}))
        `);
      });
    },
    async deletePrefix(identityId, path, isDir) {
      const likePattern = `${path}/%`;
      await db.execute(sql`
        delete from "app"."file_tags"
        where identity_id = ${identityId}
          and (path = ${path} or (${isDir} and path like ${likePattern}))
      `);
    },
  };
}

function toFavorite(row: typeof favorites.$inferSelect): Favorite {
  return {
    identityId: row.identityId,
    path: row.path,
    kind: row.kind as FavoriteKind,
    createdAt: row.createdAt,
  };
}

function createFavoriteRepo(db: Db): FavoriteRepo {
  return {
    async list(identityId) {
      const rows = await db.select().from(favorites).where(eq(favorites.identityId, identityId));
      return rows.map(toFavorite);
    },
    async add(identityId, path, kind) {
      await db
        .insert(favorites)
        .values({ identityId, path, kind })
        .onConflictDoUpdate({
          target: [favorites.identityId, favorites.path],
          set: { kind },
        });
    },
    async remove(identityId, path) {
      await db
        .delete(favorites)
        .where(and(eq(favorites.identityId, identityId), eq(favorites.path, path)));
    },
    async has(identityId, paths) {
      if (paths.length === 0) {
        return new Set();
      }
      const rows = await db
        .select({ path: favorites.path })
        .from(favorites)
        .where(and(eq(favorites.identityId, identityId), inArray(favorites.path, [...paths])));
      return new Set(rows.map((row) => row.path));
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          delete from "app"."favorites" f
          using "app"."favorites" s
          where f.identity_id = ${identityId} and s.identity_id = ${identityId}
            and f.path <> s.path
            and (
              (s.path = ${oldPath} and f.path = ${newPath})
              or (${isDir} and s.path like ${`${oldPrefix}%`} and f.path = ${newPrefix} || substr(s.path, ${oldPrefix.length + 1}))
            )
        `);
        await tx.execute(sql`
          update "app"."favorites"
          set path = case when path = ${oldPath} then ${newPath}
                          else ${newPrefix} || substr(path, ${oldPrefix.length + 1}) end
          where identity_id = ${identityId}
            and (path = ${oldPath} or (${isDir} and path like ${`${oldPrefix}%`}))
        `);
      });
    },
    async deletePrefix(identityId, path, isDir) {
      const likePattern = `${path}/%`;
      await db.execute(sql`
        delete from "app"."favorites"
        where identity_id = ${identityId}
          and (path = ${path} or (${isDir} and path like ${likePattern}))
      `);
    },
  };
}

function toRecent(row: typeof recents.$inferSelect): Recent {
  return { identityId: row.identityId, path: row.path, openedAt: row.openedAt };
}

function createRecentRepo(db: Db): RecentRepo {
  return {
    async list(identityId, limit) {
      const rows = await db
        .select()
        .from(recents)
        .where(eq(recents.identityId, identityId))
        .orderBy(sql`${recents.openedAt} desc`)
        .limit(limit);
      return rows.map(toRecent);
    },
    async touch(identityId, path) {
      const now = new Date();
      await db
        .insert(recents)
        .values({ identityId, path, openedAt: now })
        .onConflictDoUpdate({
          target: [recents.identityId, recents.path],
          set: { openedAt: now },
        });
    },
    async movePrefix(identityId, oldPath, newPath, isDir) {
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          delete from "app"."recents" f
          using "app"."recents" s
          where f.identity_id = ${identityId} and s.identity_id = ${identityId}
            and f.path <> s.path
            and (
              (s.path = ${oldPath} and f.path = ${newPath})
              or (${isDir} and s.path like ${`${oldPrefix}%`} and f.path = ${newPrefix} || substr(s.path, ${oldPrefix.length + 1}))
            )
        `);
        await tx.execute(sql`
          update "app"."recents"
          set path = case when path = ${oldPath} then ${newPath}
                          else ${newPrefix} || substr(path, ${oldPrefix.length + 1}) end
          where identity_id = ${identityId}
            and (path = ${oldPath} or (${isDir} and path like ${`${oldPrefix}%`}))
        `);
      });
    },
    async deletePrefix(identityId, path, isDir) {
      const likePattern = `${path}/%`;
      await db.execute(sql`
        delete from "app"."recents"
        where identity_id = ${identityId}
          and (path = ${path} or (${isDir} and path like ${likePattern}))
      `);
    },
    async prune(identityId, keep) {
      await db.execute(sql`
        delete from "app"."recents"
        where identity_id = ${identityId}
          and path not in (
            select path from "app"."recents"
            where identity_id = ${identityId}
            order by opened_at desc
            limit ${keep}
          )
      `);
    },
  };
}

/** Builds every `Repos` interface as Drizzle queries against `db`. */
export function createRepos(db: Db): Repos {
  return {
    providers: createProviderRepo(db),
    accounts: createAccountRepo(db),
    identities: createIdentityRepo(db),
    credentials: createCredentialRepo(db),
    sessions: createSessionRepo(db),
    settings: createSettingsRepo(db),
    apiTokens: createApiTokenRepo(db),
    tags: createTagRepo(db),
    fileTags: createFileTagRepo(db),
    favorites: createFavoriteRepo(db),
    recents: createRecentRepo(db),
  };
}
