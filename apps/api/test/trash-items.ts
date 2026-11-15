import { randomUUID } from "node:crypto";
import type { PendingTrashItem, TrashItem, TrashItemChanges, TrashItemRepo } from "@fdrive/db";

type Row = TrashItem & { movingFrom: string | null };

/** `TrashItemRepo` over memory, and the changes a transaction makes to it. */
export interface MemoryTrashItemRepo extends TrashItemRepo {
  readonly rows: Map<string, Row>;
  /**
   * Changes in one transaction: each is checked when asked and kept only
   * once `commit` runs, as the access repository's transaction does.
   */
  transaction(): { changes: TrashItemChanges; commit(): void };
}

const arrived = ({ movingFrom: _, ...item }: Row): TrashItem => item;

/**
 * `app.trash_items` in memory, for route and service tests. The listing's
 * order, newest first, and what is pending match the database's; the
 * transaction itself, and activity's bindings, are tested against
 * PostgreSQL (`packages/db/test/integration/trash-items.test.ts`).
 */
export function memoryTrashItemRepo(): MemoryTrashItemRepo {
  const rows = new Map<string, Row>();
  const listed = (identityId: string) =>
    [...rows.values()]
      .filter((row) => row.identityId === identityId && row.movingFrom === null)
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    rows,
    async begin(item) {
      const row = { ...item, id: randomUUID() };
      rows.set(row.id, row);
      return row;
    },
    async get(identityId, id) {
      const row = rows.get(id);
      return row?.identityId === identityId && row.movingFrom === null ? arrived(row) : null;
    },
    async list(identityId, limit) {
      const all = listed(identityId);
      return { items: all.slice(0, limit).map(arrived), truncated: all.length > limit };
    },
    async expired(identityId, before) {
      return listed(identityId)
        .filter((row) => row.deletedAt < before)
        .reverse()
        .map(arrived);
    },
    async pending() {
      return [...rows.values()].filter(
        (row): row is PendingTrashItem & Row => row.movingFrom !== null,
      );
    },
    async abandon(id) {
      if (rows.get(id)?.movingFrom != null) rows.delete(id);
    },
    transaction() {
      const kept: (() => void)[] = [];
      return {
        changes: {
          async entered(id) {
            const row = rows.get(id);
            if (row?.movingFrom == null) return false;
            kept.push(() => rows.set(id, { ...row, movingFrom: null }));
            return true;
          },
          async left(id) {
            kept.push(() => rows.delete(id));
          },
        },
        commit() {
          for (const keep of kept) keep();
        },
      };
    },
  };
}
