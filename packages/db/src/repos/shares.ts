import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../index.js";
import { shares } from "../schema/app.js";
import {
  parseShareScope,
  type ShareRecord,
  type ShareRepo,
  shareListLimit,
  shareStoredValues,
  validateShareId,
  validateShareOwnership,
  validateShareUpsert,
} from "./shares-state.js";

function toShareRecord(row: typeof shares.$inferSelect): ShareRecord {
  return { ...row, scope: parseShareScope(row.scope) };
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
        .returning();
      if (!row) throw new Error("Share upsert returned no row");
      return toShareRecord(row);
    },
    async get(id) {
      validateShareId(id);
      const [row] = await db.select().from(shares).where(eq(shares.id, id));
      return row ? toShareRecord(row) : null;
    },
    async getOwned(identityId, id) {
      validateShareOwnership(identityId, id);
      const [row] = await db
        .select()
        .from(shares)
        .where(and(eq(shares.identityId, identityId), eq(shares.id, id)));
      return row ? toShareRecord(row) : null;
    },
    async listOwned(identityId, options) {
      validateShareId(identityId);
      const limit = shareListLimit(options);
      const rows = await db
        .select()
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
  };
}
