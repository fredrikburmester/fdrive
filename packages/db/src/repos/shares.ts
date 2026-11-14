import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../index.js";
import { shares } from "../schema/app.js";
import {
  parseSharePresentation,
  parseShareScope,
  type ShareRecord,
  type ShareRepo,
  shareEditableValues,
  shareListLimit,
  validateShareId,
  validateShareInsert,
  validateShareOwnedUpdate,
  validateShareOwnership,
  validateSharePathChange,
} from "./shares-state.js";

// The record projection: every column but the password hash, which only
// `passwordHash` reads, so no listing or public lookup can carry it.
const { passwordHash: _passwordHash, ...recordColumns } = getTableColumns(shares);

type RecordRow = Omit<typeof shares.$inferSelect, "passwordHash">;

/**
 * `ShareRepo.movePrefix` as one statement on `db`, so a caller already in a
 * transaction (the Mac's metadata recovery) applies it there. Each row's new
 * paths are computed from the row as it is when the update reaches it, so a
 * concurrent edit or move of the same share is never lost; a path the move
 * lands on twice is kept once, where it first stood.
 */
export async function moveSharePrefix(
  db: Pick<Db, "execute">,
  identityId: string,
  from: string,
  to: string,
  isDir: boolean,
): Promise<void> {
  validateSharePathChange(identityId, from, to);
  if (from === to) return;
  const prefix = `${from}/`;
  await db.execute(sql`
    update "app"."shares" as link
    set paths = array(
      select moved.path
      from (
        select case
                 when entry.path = ${from} then ${to}
                 when ${isDir} and starts_with(entry.path, ${prefix})
                   then ${`${to}/`} || substr(entry.path, char_length(${prefix}) + 1)
                 else entry.path
               end as path,
               entry.ord
        from unnest(link.paths) with ordinality as entry(path, ord)
      ) as moved
      group by moved.path
      order by min(moved.ord)
    )
    where link.identity_id = ${identityId}
      and exists (
        select 1 from unnest(link.paths) as entry(path)
        where entry.path = ${from} or (${isDir} and starts_with(entry.path, ${prefix}))
      )
  `);
}

/**
 * `ShareRepo.deletePrefix` on `db`, for a caller already in a transaction.
 * It is two statements, so `deletePrefix` runs it in one of its own: the
 * shares that keep a path lose the deleted ones, then those left with
 * nothing but deleted paths go.
 */
export async function deleteSharePrefix(
  db: Pick<Db, "execute">,
  identityId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  validateSharePathChange(identityId, path);
  const prefix = `${path}/`;
  const deleted = (column: SQL) =>
    sql`(${column} = ${path} or (${isDir} and starts_with(${column}, ${prefix})))`;
  await db.execute(sql`
    update "app"."shares" as link
    set paths = array(
      select entry.path
      from unnest(link.paths) with ordinality as entry(path, ord)
      where not ${deleted(sql`entry.path`)}
      order by entry.ord
    )
    where link.identity_id = ${identityId}
      and exists (select 1 from unnest(link.paths) as entry(path) where ${deleted(sql`entry.path`)})
      and exists (select 1 from unnest(link.paths) as entry(path) where not ${deleted(sql`entry.path`)})
  `);
  await db.execute(sql`
    delete from "app"."shares" as link
    where link.identity_id = ${identityId}
      and not exists (
        select 1 from unnest(link.paths) as entry(path) where not ${deleted(sql`entry.path`)}
      )
  `);
}

function toShareRecord(row: RecordRow): ShareRecord {
  return {
    ...row,
    scope: parseShareScope(row.scope),
    presentation: parseSharePresentation(row.presentation),
  };
}
export function createShareRepo(db: Db): ShareRepo {
  return {
    async insert(input) {
      validateShareInsert(input);
      const [row] = await db
        .insert(shares)
        .values({
          ...shareEditableValues(input),
          identityId: input.identityId,
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
        .where(and(eq(shares.identityId, identityId), eq(shares.id, id)))
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
    movePrefix(identityId, from, to, isDir) {
      return moveSharePrefix(db, identityId, from, to, isDir);
    },
    async deletePrefix(identityId, path, isDir) {
      validateSharePathChange(identityId, path);
      await db.transaction((tx) => deleteSharePrefix(tx, identityId, path, isDir));
    },
    async passwordHash(id) {
      validateShareId(id);
      const [row] = await db
        .select({ passwordHash: shares.passwordHash })
        .from(shares)
        .where(eq(shares.id, id));
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
            or(eq(shares.maxDownloads, 0), lt(shares.views, shares.maxDownloads)),
            or(isNull(shares.expiresAt), gt(shares.expiresAt, now)),
          ),
        )
        .returning(recordColumns);
      return row ? toShareRecord(row) : null;
    },
  };
}
