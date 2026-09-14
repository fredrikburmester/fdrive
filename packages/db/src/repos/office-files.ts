import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { officeFiles } from "../schema/app.js";
import {
  escapeOfficeLike,
  type OfficeFileRepo,
  validateOfficeDelete,
  validateOfficeId,
  validateOfficeLocation,
  validateOfficeMove,
} from "./office-files-state.js";
import type { OfficeQueryExecutor, OfficeTransactionRunner } from "./office-write-scope.js";

const columns = {
  id: officeFiles.id,
  providerId: officeFiles.providerId,
  rootName: officeFiles.rootName,
  path: officeFiles.path,
  createdAt: officeFiles.createdAt,
};
function scope(providerId: string, rootName: string) {
  return and(
    eq(officeFiles.providerId, providerId),
    eq(officeFiles.rootName, rootName),
    isNull(officeFiles.deletedAt),
  );
}
function prefix(path: string) {
  return path === ""
    ? sql`true`
    : or(eq(officeFiles.path, path), like(officeFiles.path, `${escapeOfficeLike(path)}/%`));
}
function lockKey(providerId: string, rootName: string): string {
  return JSON.stringify(["office-files", providerId, rootName]);
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
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(location.providerId, location.rootName)}, 0))`,
        );
        const [existing] = await tx
          .select(columns)
          .from(officeFiles)
          .where(
            and(scope(location.providerId, location.rootName), eq(officeFiles.path, location.path)),
          );
        if (existing) return existing;
        const [created] = await tx.insert(officeFiles).values(location).returning(columns);
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
      if (move.from === move.to) return;
      await runTransaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(move.providerId, move.rootName)}, 0))`,
        );
        const activeScope = scope(move.providerId, move.rootName);
        // A replay can have a large destination and no source. Avoid a join on that case.
        const [source] = await tx
          .select({ id: officeFiles.id })
          .from(officeFiles)
          .where(and(activeScope, prefix(move.from)))
          .limit(1);
        if (!source) return;
        // Match replacements in SQL with indexed equality in both directions.
        // Replayed moves must also stay efficient when the source subtree is absent.
        await tx.execute(sql`
          update app.office_files as destination
          set deleted_at = ${move.at}
          from app.office_files as source
          where destination.provider_id = ${move.providerId}
            and destination.root_name = ${move.rootName}
            and destination.deleted_at is null
            and (destination.path = ${move.to}
              or destination.path like ${`${escapeOfficeLike(move.to)}/%`})
            and source.provider_id = ${move.providerId}
            and source.root_name = ${move.rootName}
            and source.deleted_at is null
            and (source.path = ${move.from}
              or source.path like ${`${escapeOfficeLike(move.from)}/%`})
            and destination.path = ${move.to}
              || substring(source.path from ${Array.from(move.from).length + 1}::integer)
            and source.path = ${move.from}
              || substring(destination.path from ${Array.from(move.to).length + 1}::integer)
        `);
        // Prefixes are disjoint; no source path can collide with another destination.
        await tx
          .update(officeFiles)
          .set({
            path: sql`${move.to} || substring(${officeFiles.path} from ${Array.from(move.from).length + 1}::integer)`,
            revision: sql`gen_random_uuid()`,
          })
          .where(and(activeScope, prefix(move.from)));
      });
    },
    async deletePrefix(deletion) {
      assertActive();
      validateOfficeDelete(deletion);
      await runTransaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(deletion.providerId, deletion.rootName)}, 0))`,
        );
        await tx
          .update(officeFiles)
          .set({ deletedAt: deletion.at })
          .where(and(scope(deletion.providerId, deletion.rootName), prefix(deletion.path)));
      });
    },
  };
}
