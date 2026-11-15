import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { officeFiles } from "../schema/app.js";
import {
  escapeOfficeLike,
  type OfficeFileLocation,
  type OfficeFileRepo,
  validateOfficeDelete,
  validateOfficeId,
  validateOfficeLocation,
  validateOfficeMove,
} from "./office-files-state.js";
import type { OfficeQueryExecutor, OfficeTransactionRunner } from "./office-write-scope.js";

const columns = {
  id: officeFiles.id,
  identityId: officeFiles.identityId,
  path: officeFiles.path,
  createdAt: officeFiles.createdAt,
};
/** The active rows at `prefix` and under it. */
function under(prefix: OfficeFileLocation) {
  return and(
    eq(officeFiles.identityId, prefix.identityId),
    isNull(officeFiles.deletedAt),
    or(
      eq(officeFiles.path, prefix.path),
      like(officeFiles.path, `${escapeOfficeLike(prefix.path)}/%`),
    ),
  );
}
/**
 * Takes the registry locks of the owners' files until the transaction ends,
 * in one order, so a move from one owner's files into another's never
 * deadlocks with the reverse move.
 */
async function lockOwners(tx: OfficeQueryExecutor, ...identityIds: string[]): Promise<void> {
  for (const identityId of [...new Set(identityIds)].sort())
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`office-files:${identityId}`}, 0))`,
    );
}

export function createOfficeFileRepo(db: Db): OfficeFileRepo {
  return createOfficeFileRepoWithRunner(db, (callback) => db.transaction(callback));
}

/** Internal composition seam for the office write coordinator. */
export function createOfficeFileRepoWithRunner(
  db: OfficeQueryExecutor,
  runTransaction: OfficeTransactionRunner,
  assertActive: () => void = () => {},
): OfficeFileRepo {
  return {
    async ensure(location) {
      assertActive();
      validateOfficeLocation(location);
      return runTransaction(async (tx) => {
        await lockOwners(tx, location.identityId);
        const [existing] = await tx
          .select(columns)
          .from(officeFiles)
          .where(
            and(
              eq(officeFiles.identityId, location.identityId),
              eq(officeFiles.path, location.path),
              isNull(officeFiles.deletedAt),
            ),
          );
        if (existing) return existing;
        const [created] = await tx
          .insert(officeFiles)
          .values({ identityId: location.identityId, path: location.path })
          .returning(columns);
        if (!created) throw new Error("Office file insert returned no row");
        return created;
      });
    },
    async get(id) {
      assertActive();
      validateOfficeId(id);
      const [file] = await db
        .select(columns)
        .from(officeFiles)
        .where(and(eq(officeFiles.id, id), isNull(officeFiles.deletedAt)));
      return file ?? null;
    },
    async movePrefix(move) {
      assertActive();
      validateOfficeMove(move);
      const { from, to } = move;
      if (from.identityId === to.identityId && from.path === to.path) return;
      await runTransaction(async (tx) => {
        await lockOwners(tx, from.identityId, to.identityId);
        // A replay can have a large destination and no source. Avoid a join on that case.
        const [source] = await tx
          .select({ id: officeFiles.id })
          .from(officeFiles)
          .where(under(from))
          .limit(1);
        if (!source) return;
        // Match replacements in SQL with indexed equality in both directions.
        // Replayed moves must also stay efficient when the source subtree is absent.
        await tx.execute(sql`
          update app.office_files as destination
          set deleted_at = ${move.at}
          from app.office_files as source
          where destination.identity_id = ${to.identityId}
            and destination.deleted_at is null
            and (destination.path = ${to.path}
              or destination.path like ${`${escapeOfficeLike(to.path)}/%`})
            and source.identity_id = ${from.identityId}
            and source.deleted_at is null
            and (source.path = ${from.path}
              or source.path like ${`${escapeOfficeLike(from.path)}/%`})
            and destination.path = ${to.path}
              || substring(source.path from ${Array.from(from.path).length + 1}::integer)
            and source.path = ${from.path}
              || substring(destination.path from ${Array.from(to.path).length + 1}::integer)
        `);
        // Prefixes are disjoint within one owner's files; no source path can
        // collide with another destination.
        await tx
          .update(officeFiles)
          .set({
            identityId: to.identityId,
            path: sql`${to.path} || substring(${officeFiles.path} from ${Array.from(from.path).length + 1}::integer)`,
          })
          .where(under(from));
      });
    },
    async deletePrefix(deletion) {
      assertActive();
      validateOfficeDelete(deletion);
      await runTransaction(async (tx) => {
        await lockOwners(tx, deletion.identityId);
        await tx.update(officeFiles).set({ deletedAt: deletion.at }).where(under(deletion));
      });
    },
  };
}
