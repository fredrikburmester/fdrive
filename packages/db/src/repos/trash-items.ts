import { and, asc, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "../index.js";
import { trashItems } from "../schema/app.js";

/** One item in a user's Trash (`app.trash_items`). */
export interface TrashItem {
  readonly id: string;
  /** The login whose files hold it: the owner's, for something deleted from a folder they share. */
  readonly identityId: string;
  /** Where it was deleted from, in those files. */
  readonly originalPath: string;
  /** Its name, the last segment of its path in Trash, `/.trash/<id>/<name>`. */
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly deletedAt: Date;
}

/** An item on its way into Trash from `movingFrom`, in the same files. */
export interface PendingTrashItem extends TrashItem {
  readonly movingFrom: string;
}

/** A page of one user's Trash. */
export interface TrashItemPage {
  readonly items: TrashItem[];
  /** True when there is more than `limit` items. */
  readonly truncated: boolean;
}

export interface TrashItemRepo {
  /**
   * Writes an item, with a new id, as on its way into Trash, before it
   * moves: committed on its own, so whoever finds the row later settles it
   * by what is on disk (`TrashItemChanges.entered`, `abandon`).
   */
  begin(item: Omit<PendingTrashItem, "id">): Promise<PendingTrashItem>;
  /** Item `id` in `identityId`'s Trash; null when it is not there or still on its way. */
  get(identityId: string, id: string): Promise<TrashItem | null>;
  /** `identityId`'s Trash, newest first, at most `limit` items, in one query. */
  list(identityId: string, limit: number): Promise<TrashItemPage>;
  /** `identityId`'s items deleted before `before`, oldest first. */
  expired(identityId: string, before: Date): Promise<TrashItem[]>;
  /** Every item still on its way into Trash. */
  pending(): Promise<PendingTrashItem[]>;
  /** Forgets item `id` while it is still on its way: it never arrived. */
  abandon(id: string): Promise<void>;
}

/** What a file operation's transaction changes in Trash (`AccessRepo.run`, `DesktopRepo.complete`). */
export interface TrashItemChanges {
  /**
   * Item `id`, on its way into Trash, is there now, at `leaf`: Trash lists it
   * from now on. False when it was not on its way any more, settled already
   * or given up.
   */
  entered(id: string, leaf: string): Promise<boolean>;
  /** Item `id` left Trash, restored or deleted for good. */
  left(id: string): Promise<void>;
}

type Executor = Pick<Db, "select" | "insert" | "update" | "delete">;

const columns = {
  id: trashItems.id,
  identityId: trashItems.identityId,
  originalPath: trashItems.originalPath,
  name: trashItems.name,
  kind: trashItems.kind,
  size: trashItems.size,
  deletedAt: trashItems.deletedAt,
};

/** `TrashItemChanges` in the transaction `tx`. */
export function trashItemChanges(tx: Executor): TrashItemChanges {
  return {
    async entered(id) {
      // Waits for a transaction settling the same item, then finds it settled.
      const [arriving] = await tx
        .select({ id: trashItems.id })
        .from(trashItems)
        .where(and(eq(trashItems.id, id), isNotNull(trashItems.movingFrom)))
        .for("update");
      if (arriving === undefined) return false;
      await tx.update(trashItems).set({ movingFrom: null }).where(eq(trashItems.id, id));
      return true;
    },
    async left(id) {
      await tx.delete(trashItems).where(eq(trashItems.id, id));
    },
  };
}

export function createTrashItemRepo(db: Db): TrashItemRepo {
  return {
    async begin(item) {
      const [row] = await db.insert(trashItems).values(item).returning();
      return row as PendingTrashItem;
    },
    async get(identityId, id) {
      const [row] = await db
        .select(columns)
        .from(trashItems)
        .where(
          and(
            eq(trashItems.id, id),
            eq(trashItems.identityId, identityId),
            isNull(trashItems.movingFrom),
          ),
        );
      return row ?? null;
    },
    async list(identityId, limit) {
      const rows = await db
        .select(columns)
        .from(trashItems)
        .where(and(eq(trashItems.identityId, identityId), isNull(trashItems.movingFrom)))
        .orderBy(desc(trashItems.deletedAt), desc(trashItems.id))
        .limit(limit + 1);
      return { items: rows.slice(0, limit), truncated: rows.length > limit };
    },
    expired(identityId, before) {
      return db
        .select(columns)
        .from(trashItems)
        .where(
          and(
            eq(trashItems.identityId, identityId),
            isNull(trashItems.movingFrom),
            lt(trashItems.deletedAt, before),
          ),
        )
        .orderBy(asc(trashItems.deletedAt));
    },
    async pending() {
      return (await db
        .select({ ...columns, movingFrom: trashItems.movingFrom })
        .from(trashItems)
        .where(isNotNull(trashItems.movingFrom))) as PendingTrashItem[];
    },
    async abandon(id) {
      await db
        .delete(trashItems)
        .where(and(eq(trashItems.id, id), isNotNull(trashItems.movingFrom)));
    },
  };
}
