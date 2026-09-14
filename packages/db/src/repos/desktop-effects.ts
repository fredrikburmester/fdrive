import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { desktopEffects } from "../schema/app.js";
import type {
  DesktopEffectContext,
  DesktopEffectPayload,
  DesktopEffectsRepo,
  EffectRevision,
  EffectSnapshot,
} from "./desktop-effects-types.js";

type Executor = Pick<Db, "execute">;
const tableName = (table: EffectSnapshot["table"]) =>
  sql`${sql.identifier("app")}.${sql.identifier(table)}`;
const revisions = (rows: EffectRevision[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as snapshot(path text, revision uuid)`;
const scope = (
  table: EffectSnapshot["table"],
  identityId: string,
  office: DesktopEffectContext["office"],
) =>
  table === "office_files" && office
    ? sql`item.provider_id = ${office.providerId} and item.root_name = ${office.rootName} and item.deleted_at is null`
    : sql`item.identity_id = ${identityId}`;

/** Capture bounded row revisions, never a live principal, credential or storage handle. */
export async function captureDesktopEffects(
  db: Executor,
  identityId: string,
  context: DesktopEffectContext,
): Promise<DesktopEffectPayload> {
  const snapshots: EffectSnapshot[] = [];
  let remaining = 100_000;
  async function capture(
    table: EffectSnapshot["table"],
    from: string,
    to: string | null,
    directory: boolean,
  ) {
    const read = async (path: string): Promise<EffectRevision[]> => {
      const result = await db.execute(sql`
        select item.path, item.revision from ${tableName(table)} as item
        where ${scope(table, identityId, context.office)}
          and (item.path = ${path} or (${directory} and starts_with(item.path, ${`${path}/`})))
        limit ${remaining + 1}
        for share
      `);
      remaining -= result.rows.length;
      if (remaining < 0) throw Error("Desktop metadata recovery capacity reached");
      return result.rows as unknown as EffectRevision[];
    };
    const source = await read(from);
    if (source.length)
      snapshots.push({ table, from, to, source, destination: to === null ? [] : await read(to) });
  }
  if (context.from && context.trash)
    await capture("recents", context.from, null, context.directory);
  else if (context.from && context.from !== context.to) {
    for (const table of ["file_tags", "favorites", "folder_views", "recents"] as const)
      await capture(table, context.from, context.to, context.directory);
    if (context.office)
      await capture("office_files", context.office.from, context.office.to, context.directory);
  }
  return { ...context, snapshots };
}

async function applySnapshot(
  db: Executor,
  identityId: string,
  payload: DesktopEffectPayload,
  snapshot: EffectSnapshot,
) {
  const table = tableName(snapshot.table);
  const bound = scope(snapshot.table, identityId, payload.office);
  // Identity FK locks prevent new rows; lock existing rows too, since an
  // upsert can edit one without acquiring a new foreign-key lock.
  await db.execute(sql`select item.path from ${table} as item where ${bound}
    and (item.path in (select snapshot.path from ${revisions(snapshot.source)})
      or item.path in (select snapshot.path from ${revisions(snapshot.destination)}))
    order by item.path, item.revision for update`);
  const matching = sql`select item.path, item.revision from ${table} as item
    join ${revisions(snapshot.source)} on item.path = snapshot.path and item.revision = snapshot.revision
    where ${bound}`;
  const target = sql`${snapshot.to} || substring(source.path from char_length(${snapshot.from}::text) + 1)`;
  if (snapshot.to !== null) {
    // A current target not present in the receipt's snapshot belongs to newer work.
    // Refuse the entire transaction, including its destination cleanup.
    const collision = await db.execute(sql`
      with source as (${matching})
      select 1 from ${table} as item join source on item.path = ${target}
      where ${bound} and not exists (
        select 1 from ${revisions(snapshot.destination)}
        where item.path = snapshot.path and item.revision = snapshot.revision
      ) limit 1
    `);
    if (collision.rows.length) throw new MetadataDestinationChanged();
    const targetWhere = sql`${bound} and item.path in (select ${target} from source)`;
    if (snapshot.table === "office_files") {
      await db.execute(
        sql`with source as (${matching}) update ${table} as item set deleted_at = now() where ${targetWhere}`,
      );
    } else {
      await db.execute(
        sql`with source as (${matching}) delete from ${table} as item where ${targetWhere}`,
      );
    }
  }
  if (snapshot.to === null && snapshot.table !== "office_files") {
    await db.execute(sql`delete from ${table} as item using ${revisions(snapshot.source)}
      where ${bound} and item.path = snapshot.path and item.revision = snapshot.revision`);
  } else {
    await db.execute(sql`
      update ${table} as item
      set ${snapshot.to === null ? sql`deleted_at = now()` : sql`path = ${snapshot.to} || substring(item.path from char_length(${snapshot.from}::text) + 1)`}, revision = gen_random_uuid()
      from ${revisions(snapshot.source)}
      where ${bound} and item.path = snapshot.path and item.revision = snapshot.revision
    `);
  }
}

class MetadataDestinationChanged extends Error {
  constructor() {
    super("Newer destination metadata is preserved; recovery needs attention.");
  }
}

export function createDesktopEffectsRepo(db: Db): DesktopEffectsRepo {
  return {
    async processNext(publish, identityId) {
      let claimed: typeof desktopEffects.$inferSelect | undefined;
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '15s'`);
          // An earlier pending job blocks only its own identity, including backoff
          // and a row currently held by another worker.
          const [job] = await tx
            .select()
            .from(desktopEffects)
            .where(
              and(
                eq(desktopEffects.state, "pending"),
                sql`${desktopEffects.nextAttemptAt} <= now()`,
                ...(identityId ? [eq(desktopEffects.identityId, identityId)] : []),
                sql`not exists (select 1 from app.desktop_effects earlier where earlier.identity_id = ${desktopEffects.identityId} and earlier.state = 'pending' and earlier.sequence < ${desktopEffects.sequence})`,
              ),
            )
            .orderBy(asc(desktopEffects.sequence))
            .limit(1)
            // Background workers skip busy identities. A new save waits briefly
            // for its own preceding job instead of waiting for the global batch.
            .for("update", identityId === undefined ? { skipLocked: true } : {});
          if (!job) return { state: "idle" as const };
          claimed = job;
          const owner = await tx.execute(
            sql`select account_id from app.identities where id = ${job.identityId} for update`,
          );
          const owned = owner.rows[0]?.account_id === job.accountId;
          if (owned) {
            // Office moves use the same lock ordering as its normal repository.
            const office = job.payload.office;
            if (office)
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["office-files", office.providerId, office.rootName])}, 0))`,
              );
            for (const snapshot of job.payload.snapshots)
              await applySnapshot(tx, job.identityId, job.payload, snapshot);
            const { from, to, directory, trash } = job.payload;
            publish({
              type: "fs",
              identityId: job.identityId,
              op: trash ? "delete" : from && from !== to ? "move" : directory ? "mkdir" : "create",
              paths: [from ?? to],
              ...(from && from !== to && !trash ? { targetPaths: [to] } : {}),
              at: job.createdAt.toISOString(),
            });
          }
          await tx
            .update(desktopEffects)
            .set({
              state: owned ? "completed" : "retired",
              completedAt: new Date(),
              payload: { ...job.payload, snapshots: [] },
              lastError: null,
            })
            .where(eq(desktopEffects.sequence, job.sequence));
          return {
            state: owned ? ("completed" as const) : ("retired" as const),
            identityId: job.identityId,
            operationId: job.operationId,
          };
        });
      } catch (error) {
        if (!claimed) throw error;
        const retryAt = new Date(
          Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(claimed.attempts, 9)),
        );
        await db
          .update(desktopEffects)
          .set({
            attempts: sql`${desktopEffects.attempts} + 1`,
            nextAttemptAt: retryAt,
            lastError:
              error instanceof MetadataDestinationChanged
                ? error.message
                : "Metadata recovery failed; retry scheduled.",
          })
          .where(
            and(eq(desktopEffects.sequence, claimed.sequence), eq(desktopEffects.state, "pending")),
          );
        return {
          state: "failed",
          identityId: claimed.identityId,
          operationId: claimed.operationId,
          retryAt,
        };
      }
    },
    async pending(identityId) {
      const rows = await db
        .select({ sequence: desktopEffects.sequence })
        .from(desktopEffects)
        .where(
          and(
            eq(desktopEffects.state, "pending"),
            ...(identityId ? [eq(desktopEffects.identityId, identityId)] : []),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async status() {
      return db
        .select({
          identityId: desktopEffects.identityId,
          operationId: desktopEffects.operationId,
          attempts: desktopEffects.attempts,
          lastError: desktopEffects.lastError,
          createdAt: desktopEffects.createdAt,
          nextAttemptAt: desktopEffects.nextAttemptAt,
        })
        .from(desktopEffects)
        .where(eq(desktopEffects.state, "pending"))
        .orderBy(asc(desktopEffects.sequence))
        .limit(100);
    },
  };
}
