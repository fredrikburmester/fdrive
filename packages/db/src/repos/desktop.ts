import { randomUUID } from "node:crypto";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { desktopEffects, desktopItems, desktopOperations } from "../schema/app.js";
import { captureDesktopEffects } from "./desktop-effects.js";
import type { DesktopEffectContext } from "./desktop-effects-types.js";

export type DesktopItemRecord = typeof desktopItems.$inferSelect;
export type DesktopOperationRecord = typeof desktopOperations.$inferSelect;
export interface DesktopRepo {
  ensure(identityId: string, path: string, kind: string): Promise<DesktopItemRecord>;
  item(identityId: string, id: string): Promise<DesktopItemRecord | null>;
  at(identityId: string, path: string): Promise<DesktopItemRecord | null>;
  children(identityId: string, path: string): Promise<DesktopItemRecord[]>;
  update(
    identityId: string,
    id: string,
    changes: Partial<
      Pick<DesktopItemRecord, "path" | "kind" | "contentVersion" | "originalPath" | "deletedAt">
    >,
  ): Promise<DesktopItemRecord>;
  move(identityId: string, from: string, to: string): Promise<void>;
  remove(identityId: string, path: string): Promise<void>;
  reserve(
    input: Pick<
      DesktopOperationRecord,
      "id" | "identityId" | "accountId" | "requestHash" | "request" | "state"
    >,
  ): Promise<DesktopOperationRecord>;
  operation(
    identityId: string,
    accountId: string,
    id: string,
  ): Promise<DesktopOperationRecord | null>;
  transition(
    identityId: string,
    accountId: string,
    id: string,
    expected: string,
    state: string,
    result?: Record<string, unknown>,
    attempt?: string,
  ): Promise<boolean>;
  /** Commit the publication receipt and its metadata recovery work together. */
  complete(
    identityId: string,
    accountId: string,
    id: string,
    result: Record<string, unknown>,
    effects: DesktopEffectContext,
  ): Promise<boolean>;
}
const escaped = (path: string) => path.replace(/[\\%_]/g, (value) => `\\${value}`);
const live = (identityId: string) =>
  and(eq(desktopItems.identityId, identityId), isNull(desktopItems.deletedAt));
const prefix = (path: string) =>
  or(eq(desktopItems.path, path), like(desktopItems.path, `${escaped(path)}/%`));
const op = (identityId: string, accountId: string, id: string) =>
  and(
    eq(desktopOperations.identityId, identityId),
    eq(desktopOperations.accountId, accountId),
    eq(desktopOperations.id, id),
  );

export function createDesktopRepo(db: Db): DesktopRepo {
  const repo: DesktopRepo = {
    async ensure(identityId, path, kind) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["desktop-items", identityId])},0))`,
        );
        const [existing] = await tx
          .select()
          .from(desktopItems)
          .where(and(live(identityId), eq(desktopItems.path, path)));
        if (existing?.kind === kind) return existing;
        if (existing)
          await tx
            .update(desktopItems)
            .set({ deletedAt: new Date() })
            .where(and(live(identityId), prefix(path)));
        const [created] = await tx
          .insert(desktopItems)
          .values({ identityId, path, kind })
          .returning();
        if (!created) throw Error("Desktop item insertion returned no row");
        return created;
      });
    },
    async item(identityId, id) {
      return (
        (
          await db
            .select()
            .from(desktopItems)
            .where(and(live(identityId), eq(desktopItems.id, id)))
        )[0] ?? null
      );
    },
    async at(identityId, path) {
      return (
        (
          await db
            .select()
            .from(desktopItems)
            .where(and(live(identityId), eq(desktopItems.path, path)))
        )[0] ?? null
      );
    },
    async children(identityId, path) {
      const root = path === "/" ? "" : path;
      return (
        await db
          .select()
          .from(desktopItems)
          .where(and(live(identityId), like(desktopItems.path, `${escaped(root)}/%`)))
      ).filter((item) => !item.path.slice(root.length + 1).includes("/"));
    },
    async update(identityId, id, changes) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["desktop-items", identityId])},0))`,
        );
        const [updated] = await tx
          .update(desktopItems)
          .set({ ...changes, metadataVersion: randomUUID() })
          .where(and(live(identityId), eq(desktopItems.id, id)))
          .returning();
        if (!updated) throw Error("Desktop item no longer exists");
        return updated;
      });
    },
    async move(identityId, from, to) {
      if (from === to) return;
      if (from === "/" || to === "/" || to.startsWith(`${from}/`) || from.startsWith(`${to}/`))
        throw Error("Desktop move paths overlap");
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["desktop-items", identityId])},0))`,
        );
        const source = await tx
          .select({ id: desktopItems.id })
          .from(desktopItems)
          .where(and(live(identityId), prefix(from)))
          .limit(1);
        if (!source.length) return;
        // A reader can discover the published destination before the writer has
        // updated the registry. Keep the source UUID and retire that provisional row.
        await tx
          .update(desktopItems)
          .set({ deletedAt: new Date() })
          .where(and(live(identityId), prefix(to)));
        await tx
          .update(desktopItems)
          .set({
            path: sql`${to} || substring(${desktopItems.path} from char_length(${from}::text)+1)`,
            metadataVersion: randomUUID(),
          })
          .where(and(live(identityId), prefix(from)));
      });
    },
    async remove(identityId, path) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["desktop-items", identityId])},0))`,
        );
        await tx
          .update(desktopItems)
          .set({ deletedAt: new Date() })
          .where(and(live(identityId), prefix(path)));
      });
    },
    async reserve(input) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('desktop-spool-quota',0))`,
        );
        const prior = await tx
          .select()
          .from(desktopOperations)
          .where(op(input.identityId, input.accountId, input.id));
        if (prior.length) return;
        const usage = await tx.execute(
          sql`select count(*) filter (where state not in ('acknowledged','cancelled'))::int as count, coalesce(sum(coalesce((request->>'recoveryBytes')::bigint,0) + case when state='acknowledged' then 0 else coalesce((request->>'size')::bigint,0) end),0)::text as bytes from ${desktopOperations}`,
        );
        const row = usage.rows[0] as { count: number; bytes: string };
        if (
          row.count >= 1024 ||
          Number(row.bytes) +
            Number(input.request.recoveryBytes ?? 0) +
            Number(input.request.size ?? 0) >
            64 * 1024 ** 3
        )
          throw Error("Desktop recovery capacity reached");
        await tx.insert(desktopOperations).values(input).onConflictDoNothing();
      });
      const existing = await repo.operation(input.identityId, input.accountId, input.id);
      if (!existing) throw Error("Operation belongs to another account");
      return existing;
    },
    async operation(identityId, accountId, id) {
      return (
        (
          await db
            .select()
            .from(desktopOperations)
            .where(op(identityId, accountId, id))
        )[0] ?? null
      );
    },
    async complete(identityId, accountId, id, result, effects) {
      return db.transaction(async (tx) => {
        const owner = await tx.execute(
          sql`select account_id from app.identities where id = ${identityId} for update`,
        );
        if (owner.rows[0]?.account_id !== accountId) return false;
        const updated = await tx
          .update(desktopOperations)
          .set({ state: "completed", result, updatedAt: new Date() })
          .where(and(op(identityId, accountId, id), eq(desktopOperations.state, "committing")))
          .returning({ id: desktopOperations.id });
        if (!updated.length) return false;
        const office = effects.office;
        if (office)
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["office-files", office.providerId, office.rootName])}, 0))`,
          );
        const payload = await captureDesktopEffects(tx, identityId, effects);
        await tx.insert(desktopEffects).values({ operationId: id, identityId, accountId, payload });
        return true;
      });
    },
    async transition(identityId, accountId, id, expected, state, result, attempt) {
      const updated = await db
        .update(desktopOperations)
        .set({ state, updatedAt: new Date(), ...(result === undefined ? {} : { result }) })
        .where(
          and(
            op(identityId, accountId, id),
            eq(desktopOperations.state, expected),
            ...(attempt === undefined
              ? []
              : [sql`${desktopOperations.result}->>'attempt' = ${attempt}`]),
          ),
        )
        .returning({ id: desktopOperations.id });
      return updated.length === 1;
    },
  };
  return repo;
}
