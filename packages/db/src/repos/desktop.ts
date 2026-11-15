import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { desktopItems, desktopOperations } from "../schema/app.js";
import {
  appendNativeActivity,
  finishNativeFailure,
  type NativeActivityFacts,
  prepareNativeActivity,
} from "./activity-native.js";
import { moveLocalGrantPrefix } from "./drizzle.js";
import { deleteSharePrefix, moveSharePrefix } from "./shares.js";

export type DesktopItemRecord = typeof desktopItems.$inferSelect;
/**
 * What a path's public links do after a Mac write, in their owner's files:
 * follow `from` to `to` (`ShareRepo.movePrefix`), or drop `from` when the
 * item left the owner's files (`to: null`, `ShareRepo.deletePrefix`).
 */
export interface DesktopShareMove {
  identityId: string;
  from: string;
  to: string | null;
}
/**
 * What grants access to the path a Mac write moved, applied with its receipt
 * so no public link or folder shared with people stays at a path the write
 * left, where a new item could appear.
 */
export interface DesktopAccessMove {
  directory: boolean;
  shares: DesktopShareMove | null;
  /** Folders their owner, a local username, shares with people (`LocalGrantRepo.movePrefix`). */
  grants: { owner: string; from: string; to: string } | null;
}
export type DesktopOperationRecord = typeof desktopOperations.$inferSelect;
/** Milliseconds after an operation's last change before retention acts on it. */
export interface DesktopRetention {
  /** `receiving`/`uploading` bodies that never completed: cancelled. */
  idleMs: number;
  /** `conflict` operations the app never retried or cancelled: cancelled. */
  conflictMs: number;
  /** `acknowledged`/`cancelled` operations, which the app is done with: forgotten. */
  retainMs: number;
}
export interface DesktopRepo {
  ensure(identityId: string, path: string, kind: string): Promise<DesktopItemRecord>;
  /** `ensure` for many paths in one transaction; rows return in input order. */
  ensureMany(
    identityId: string,
    items: readonly { path: string; kind: string }[],
  ): Promise<DesktopItemRecord[]>;
  /** Live rows at these paths, read without registering anything. */
  lookup(identityId: string, paths: readonly string[]): Promise<DesktopItemRecord[]>;
  item(identityId: string, id: string): Promise<DesktopItemRecord | null>;
  at(identityId: string, path: string): Promise<DesktopItemRecord | null>;
  children(identityId: string, path: string): Promise<DesktopItemRecord[]>;
  update(
    identityId: string,
    id: string,
    changes: Partial<Pick<DesktopItemRecord, "path" | "kind" | "originalPath" | "deletedAt">>,
  ): Promise<DesktopItemRecord>;
  move(identityId: string, from: string, to: string): Promise<void>;
  remove(identityId: string, path: string): Promise<void>;
  /**
   * What the Mac's own Trash held, before Finder's Trash became fdrive's: the
   * items at the top of `/.fdrive-desktop/<identity>/trash`, each with the
   * path it was deleted from, for every identity.
   */
  oldTrash(): Promise<(DesktopItemRecord & { originalPath: string })[]>;
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
  /**
   * Commit the publication receipt, its personal history and what grants
   * access to the moved path together: none of it is kept unless all is.
   */
  complete(
    identityId: string,
    accountId: string,
    id: string,
    result: Record<string, unknown>,
    activity: NativeActivityFacts,
    access?: DesktopAccessMove | null,
  ): Promise<boolean>;
  /** Operations past their retention window, oldest first. */
  expired(now: Date, retention: DesktopRetention, limit: number): Promise<DesktopOperationRecord[]>;
  /** Deletes an `acknowledged` or `cancelled` operation's row; false for any other. */
  forget(identityId: string, accountId: string, id: string): Promise<boolean>;
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

const depth = (path: string) => path.split("/").length;

export function createDesktopRepo(db: Db): DesktopRepo {
  const repo: DesktopRepo = {
    async ensure(identityId, path, kind) {
      return (await repo.ensureMany(identityId, [{ path, kind }]))[0] as DesktopItemRecord;
    },
    async ensureMany(identityId, items) {
      const kinds = new Map<string, string>();
      for (const { path, kind } of items) {
        if ((kinds.get(path) ?? kind) !== kind) throw Error("Conflicting desktop item kinds");
        kinds.set(path, kind);
      }
      if (!kinds.size) return [];
      const paths = [...kinds.keys()];
      const read = async (from: Pick<Db, "select">) =>
        new Map(
          (
            await from
              .select()
              .from(desktopItems)
              .where(and(live(identityId), inArray(desktopItems.path, paths)))
          ).map((item) => [item.path, item]),
        );
      const ordered = (found: Map<string, DesktopItemRecord>) =>
        items.map(({ path }) => found.get(path) as DesktopItemRecord);
      // Unique live paths make one committed read safe without the lock when every row exists.
      const current = await read(db);
      if (paths.every((path) => current.get(path)?.kind === kinds.get(path)))
        return ordered(current);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["desktop-items", identityId])},0))`,
        );
        let found = await read(tx);
        // Retire a replaced folder's subtree before its children are matched, so no
        // returned row belongs to a subtree this call retires.
        const replaced = paths
          .filter((path) => {
            const item = found.get(path);
            return item && item.kind !== kinds.get(path);
          })
          .sort((a, b) => depth(a) - depth(b));
        for (const path of replaced)
          await tx
            .update(desktopItems)
            .set({ deletedAt: new Date() })
            .where(and(live(identityId), prefix(path)));
        if (replaced.length) found = await read(tx);
        const missing = paths.filter((path) => !found.has(path));
        if (missing.length)
          for (const created of await tx
            .insert(desktopItems)
            .values(missing.map((path) => ({ identityId, path, kind: kinds.get(path) as string })))
            .returning())
            found.set(created.path, created);
        return ordered(found);
      });
    },
    async lookup(identityId, paths) {
      if (!paths.length) return [];
      return db
        .select()
        .from(desktopItems)
        .where(and(live(identityId), inArray(desktopItems.path, [...new Set(paths)])));
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
    async oldTrash() {
      return (await db
        .select()
        .from(desktopItems)
        .where(
          and(
            isNull(desktopItems.deletedAt),
            isNotNull(desktopItems.originalPath),
            like(desktopItems.path, "/.fdrive-desktop/%"),
          ),
        )) as (DesktopItemRecord & { originalPath: string })[];
    },
    async reserve(input) {
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(desktopOperations)
          .values(input)
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) await prepareNativeActivity(tx, inserted[0]);
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
    async complete(identityId, accountId, id, result, activity, access) {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(desktopOperations)
          .set({ state: "completed", result, updatedAt: new Date() })
          .where(and(op(identityId, accountId, id), eq(desktopOperations.state, "committing")))
          .returning();
        if (!updated.length) return false;
        const links = access?.shares;
        if (links?.to === null)
          await deleteSharePrefix(tx, links.identityId, links.from, access?.directory === true);
        else if (links)
          await moveSharePrefix(
            tx,
            links.identityId,
            links.from,
            links.to,
            access?.directory === true,
          );
        if (access?.grants)
          await moveLocalGrantPrefix(tx, access.grants.owner, access.grants.from, access.grants.to);
        await appendNativeActivity(tx, updated[0] as DesktopOperationRecord, result, activity);
        return true;
      });
    },
    async expired(now, retention, limit) {
      const before = (ms: number) => new Date(now.getTime() - ms);
      return db
        .select()
        .from(desktopOperations)
        .where(
          or(
            and(
              inArray(desktopOperations.state, ["receiving", "uploading"]),
              lt(desktopOperations.updatedAt, before(retention.idleMs)),
            ),
            and(
              eq(desktopOperations.state, "conflict"),
              lt(desktopOperations.updatedAt, before(retention.conflictMs)),
            ),
            and(
              inArray(desktopOperations.state, ["acknowledged", "cancelled"]),
              lt(desktopOperations.updatedAt, before(retention.retainMs)),
            ),
          ),
        )
        .orderBy(asc(desktopOperations.updatedAt))
        .limit(limit);
    },
    async forget(identityId, accountId, id) {
      const deleted = await db
        .delete(desktopOperations)
        .where(
          and(
            op(identityId, accountId, id),
            inArray(desktopOperations.state, ["acknowledged", "cancelled"]),
          ),
        )
        .returning({ id: desktopOperations.id });
      return deleted.length === 1;
    },
    async transition(identityId, accountId, id, expected, state, result, attempt) {
      return db.transaction(async (tx) => {
        const updated = await tx
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
          .returning();
        if (updated[0]) await finishNativeFailure(tx, updated[0]);
        return updated.length === 1;
      });
    },
  };
  return repo;
}
