import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { accounts, credentials, identities, providers, sessions, settings } from "../schema/app.js";
import type {
  Account,
  AccountRepo,
  Credential,
  CredentialRepo,
  Identity,
  IdentityRepo,
  Provider,
  ProviderRepo,
  Repos,
  Session,
  SessionRepo,
  SettingsRepo,
} from "./types.js";

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

/** Builds every `Repos` interface as Drizzle queries against `db`. */
export function createRepos(db: Db): Repos {
  return {
    providers: createProviderRepo(db),
    accounts: createAccountRepo(db),
    identities: createIdentityRepo(db),
    credentials: createCredentialRepo(db),
    sessions: createSessionRepo(db),
    settings: createSettingsRepo(db),
  };
}
