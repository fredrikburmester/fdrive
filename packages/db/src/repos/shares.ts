import { and, asc, desc, eq, getTableColumns, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { shares } from "../schema/app.js";
import {
  parseSharePresentation,
  parseShareScope,
  type ShareRecord,
  type ShareRepo,
  shareEditableValues,
  shareListLimit,
  shareStoredValues,
  validateShareId,
  validateShareInsert,
  validateShareOwnedUpdate,
  validateShareOwnership,
  validateShareUpsert,
} from "./shares-state.js";

// The record projection: every column but the password hash, which only
// `passwordHash` reads, so no listing or public lookup can carry it.
const { passwordHash: _passwordHash, ...recordColumns } = getTableColumns(shares);

type RecordRow = Omit<typeof shares.$inferSelect, "passwordHash">;

function toShareRecord(row: RecordRow): ShareRecord {
  return {
    ...row,
    scope: parseShareScope(row.scope),
    presentation: parseSharePresentation(row.presentation),
  };
}
export function createShareRepo(db: Db): ShareRepo {
  return {
    async upsert(input) {
      validateShareUpsert(input);
      const values = shareStoredValues(input);
      const [row] = await db
        .insert(shares)
        .values({ ...values, createdAt: input.at })
        .onConflictDoUpdate({ target: [shares.identityId, shares.sftpgoShareId], set: values })
        .returning(recordColumns);
      if (!row) throw new Error("Share upsert returned no row");
      return toShareRecord(row);
    },
    async insert(input) {
      validateShareInsert(input);
      const [row] = await db
        .insert(shares)
        .values({
          ...shareEditableValues(input),
          identityId: input.identityId,
          sftpgoShareId: null,
          hasPassword: input.passwordHash !== null,
          passwordHash: input.passwordHash,
          createdAt: input.at,
          updatedAt: input.at,
        })
        .returning(recordColumns);
      if (!row) throw new Error("Share insert returned no row");
      return toShareRecord(row);
    },
    async updateOwned(identityId, id, input) {
      validateShareOwnedUpdate(identityId, id, input);
      const [row] = await db
        .update(shares)
        .set({
          ...shareEditableValues(input),
          updatedAt: input.at,
          ...(input.passwordHash === undefined
            ? {}
            : { passwordHash: input.passwordHash, hasPassword: input.passwordHash !== null }),
        })
        .where(
          and(eq(shares.identityId, identityId), eq(shares.id, id), isNull(shares.sftpgoShareId)),
        )
        .returning(recordColumns);
      return row ? toShareRecord(row) : null;
    },
    async get(id) {
      validateShareId(id);
      const [row] = await db.select(recordColumns).from(shares).where(eq(shares.id, id));
      return row ? toShareRecord(row) : null;
    },
    async getOwned(identityId, id) {
      validateShareOwnership(identityId, id);
      const [row] = await db
        .select(recordColumns)
        .from(shares)
        .where(and(eq(shares.identityId, identityId), eq(shares.id, id)));
      return row ? toShareRecord(row) : null;
    },
    async listOwned(identityId, options) {
      validateShareId(identityId);
      const limit = shareListLimit(options);
      const rows = await db
        .select(recordColumns)
        .from(shares)
        .where(eq(shares.identityId, identityId))
        .orderBy(desc(shares.createdAt), asc(shares.id))
        .limit(limit);
      return rows.map(toShareRecord);
    },
    async removeOwned(identityId, id) {
      validateShareOwnership(identityId, id);
      const removed = await db
        .delete(shares)
        .where(and(eq(shares.identityId, identityId), eq(shares.id, id)))
        .returning({ id: shares.id });
      return removed.length > 0;
    },
    async passwordHash(id) {
      validateShareId(id);
      const [row] = await db
        .select({ passwordHash: shares.passwordHash })
        .from(shares)
        .where(and(eq(shares.id, id), isNull(shares.sftpgoShareId)));
      return row?.passwordHash ?? null;
    },
    async consume(id, now) {
      validateShareId(id);
      // One statement: the row lock serializes concurrent downloads and the
      // limit is re-checked against the row each one leaves behind.
      const [row] = await db
        .update(shares)
        .set({ views: sql`${shares.views} + 1` })
        .where(
          and(
            eq(shares.id, id),
            isNull(shares.sftpgoShareId),
            or(eq(shares.maxDownloads, 0), lt(shares.views, shares.maxDownloads)),
            or(isNull(shares.expiresAt), gt(shares.expiresAt, now)),
          ),
        )
        .returning(recordColumns);
      return row ? toShareRecord(row) : null;
    },
  };
}
