import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { apiTokens, encryptionDeviceKeys, encryptionKeys } from "../schema/app.js";

/**
 * A login's end-to-end encryption keys (`app.encryption_keys`). Every key
 * here is an age file the server cannot open; `recipient` is public.
 */
export interface EncryptionKeys {
  readonly identityId: string;
  readonly recipient: string;
  readonly passwordKey: string;
  readonly recoveryKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A paired Mac holding a copy of the account key, named after its desktop token. */
export interface EncryptionDevice {
  readonly tokenId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface EncryptionKeyRepo {
  get(identityId: string): Promise<EncryptionKeys | null>;
  /** Stores a login's first keys; null when it already has some, which stay as they are. */
  create(
    keys: Pick<EncryptionKeys, "identityId" | "recipient" | "passwordKey" | "recoveryKey">,
  ): Promise<EncryptionKeys | null>;
  /** Replaces the password copy; false when the login has no keys. */
  setPasswordKey(identityId: string, passwordKey: string): Promise<boolean>;
  /** Deletes a login's keys and every Mac's copy of them; false when it had none. */
  remove(identityId: string): Promise<boolean>;
  /** The Macs holding a copy of the login's key, oldest first. */
  devices(identityId: string): Promise<EncryptionDevice[]>;
  /**
   * Stores a Mac's copy, kept with its desktop token. False when the login
   * has no keys or the token is not the login's.
   */
  setDeviceKey(tokenId: string, identityId: string, deviceKey: string): Promise<boolean>;
  /** A desktop token's copy with the account recipient it opens to; null when it has none. */
  deviceKey(tokenId: string): Promise<{ recipient: string; deviceKey: string } | null>;
  /** Deletes one Mac's copy; false when the login had no copy under that token. */
  removeDevice(identityId: string, tokenId: string): Promise<boolean>;
}

export function createEncryptionKeyRepo(db: Db): EncryptionKeyRepo {
  return {
    async get(identityId) {
      const [row] = await db
        .select()
        .from(encryptionKeys)
        .where(eq(encryptionKeys.identityId, identityId));
      return row ?? null;
    },

    async create(keys) {
      const [row] = await db.insert(encryptionKeys).values(keys).onConflictDoNothing().returning();
      return row ?? null;
    },

    async setPasswordKey(identityId, passwordKey) {
      const rows = await db
        .update(encryptionKeys)
        .set({ passwordKey, updatedAt: sql`now()` })
        .where(eq(encryptionKeys.identityId, identityId))
        .returning({ identityId: encryptionKeys.identityId });
      return rows.length > 0;
    },

    async remove(identityId) {
      const rows = await db
        .delete(encryptionKeys)
        .where(eq(encryptionKeys.identityId, identityId))
        .returning({ identityId: encryptionKeys.identityId });
      return rows.length > 0;
    },

    async devices(identityId) {
      return db
        .select({
          tokenId: encryptionDeviceKeys.tokenId,
          name: apiTokens.name,
          createdAt: encryptionDeviceKeys.createdAt,
        })
        .from(encryptionDeviceKeys)
        .innerJoin(apiTokens, eq(apiTokens.id, encryptionDeviceKeys.tokenId))
        .where(eq(encryptionDeviceKeys.identityId, identityId))
        .orderBy(asc(encryptionDeviceKeys.createdAt), asc(encryptionDeviceKeys.tokenId));
    },

    async setDeviceKey(tokenId, identityId, deviceKey) {
      // Both rows must exist and agree, checked in the insert itself.
      const rows = await db
        .insert(encryptionDeviceKeys)
        .select(
          db
            .select({
              tokenId: apiTokens.id,
              identityId: encryptionKeys.identityId,
              deviceKey: sql<string>`${deviceKey}`.as("device_key"),
              createdAt: sql<Date>`now()`.as("created_at"),
            })
            .from(apiTokens)
            .innerJoin(encryptionKeys, eq(encryptionKeys.identityId, apiTokens.identityId))
            .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.identityId, identityId))),
        )
        .onConflictDoUpdate({
          target: encryptionDeviceKeys.tokenId,
          set: { deviceKey, createdAt: sql`now()` },
        })
        .returning({ tokenId: encryptionDeviceKeys.tokenId });
      return rows.length > 0;
    },

    async deviceKey(tokenId) {
      const [row] = await db
        .select({
          recipient: encryptionKeys.recipient,
          deviceKey: encryptionDeviceKeys.deviceKey,
        })
        .from(encryptionDeviceKeys)
        .innerJoin(encryptionKeys, eq(encryptionKeys.identityId, encryptionDeviceKeys.identityId))
        .where(eq(encryptionDeviceKeys.tokenId, tokenId));
      return row ?? null;
    },

    async removeDevice(identityId, tokenId) {
      const rows = await db
        .delete(encryptionDeviceKeys)
        .where(
          and(
            eq(encryptionDeviceKeys.tokenId, tokenId),
            eq(encryptionDeviceKeys.identityId, identityId),
          ),
        )
        .returning({ tokenId: encryptionDeviceKeys.tokenId });
      return rows.length > 0;
    },
  };
}
