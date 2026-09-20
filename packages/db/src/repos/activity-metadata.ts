import type { ActivityFacts, ActivitySubject, PersonalActivityAction } from "@fdrive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { favorites, fileTags, folderViews, identities, tags } from "../schema/app.js";
import { ensureActivityFile, lockActivityRegistry } from "./activity-registry.js";
import { captureActivityIdentity } from "./activity-writer.js";

/** Current values and membership, read on the same transaction that changes metadata. */
export async function captureActivityMetadata(
  db: Db,
  accountId: string,
  identityId: string,
  action: PersonalActivityAction,
  requested: ActivityFacts,
  now = new Date(),
) {
  await db.execute(sql`select id from app.accounts where id = ${accountId} for no key update`);
  const linked = await db
    .select()
    .from(identities)
    .where(eq(identities.accountId, accountId))
    .orderBy(identities.id)
    .for("update");
  if (!linked.some((identity) => identity.id === identityId))
    throw Error("Identity ownership changed");
  for (const identity of linked) {
    await captureActivityIdentity(db, { accountId, identityId: identity.id });
    await lockActivityRegistry(db, identity.id);
  }
  const before: ActivityFacts = { ...(requested.path ? { path: requested.path } : {}) };
  let paths: { identityId: string; path: string; kind?: "file" | "dir" }[] = [];
  let absent = false;
  if (action === "tag.update" || action === "tag.delete") {
    const id = requested.tags?.[0]?.id;
    const current = id
      ? await db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .where(and(eq(tags.accountId, accountId), eq(tags.id, id)))
      : [];
    before.tags = current;
    absent = !current.length;
    if (id)
      paths = await db
        .selectDistinct({ identityId: fileTags.identityId, path: fileTags.path })
        .from(fileTags)
        .innerJoin(
          identities,
          and(eq(identities.id, fileTags.identityId), eq(identities.accountId, accountId)),
        )
        .where(eq(fileTags.tagId, id));
  } else if (action === "file.tags.set" && requested.path) {
    before.tags = await db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(fileTags)
      .innerJoin(tags, and(eq(tags.id, fileTags.tagId), eq(tags.accountId, accountId)))
      .where(and(eq(fileTags.identityId, identityId), eq(fileTags.path, requested.path)))
      .orderBy(tags.id);
  } else if (action === "file.favorite.set" && requested.path) {
    before.favorite =
      (
        await db
          .select()
          .from(favorites)
          .where(and(eq(favorites.identityId, identityId), eq(favorites.path, requested.path)))
      ).length > 0;
  } else if (action === "folder.view.set" || action === "folder.view.reset") {
    const rows = await db
      .select({
        identityId: folderViews.identityId,
        path: folderViews.path,
        mode: folderViews.mode,
      })
      .from(folderViews)
      .innerJoin(
        identities,
        and(eq(identities.id, folderViews.identityId), eq(identities.accountId, accountId)),
      )
      .where(
        requested.variant === "all"
          ? undefined
          : and(eq(folderViews.identityId, identityId), eq(folderViews.path, requested.path ?? "")),
      );
    absent = !rows.length;
    // A folder view row can pin only a sort, leaving the mode null; that is no view to record.
    const mode = requested.variant === "all" ? null : rows[0]?.mode;
    if (mode) before.view = ActivityView(mode);
    paths = rows.map((row) => ({ identityId: row.identityId, path: row.path, kind: "dir" }));
  }
  const subjects: ActivitySubject[] = [];
  for (const path of paths) {
    const file = await ensureActivityFile(db, path.identityId, path.path, path.kind, now);
    subjects.push({
      fileId: file?.id ?? null,
      identityId: path.identityId,
      path: path.path,
      role: "affected",
      ordinal: subjects.length,
      revisionId: file?.revisionId ?? null,
    });
  }
  return { before, subjects, absent };
}
function ActivityView(value: string): NonNullable<ActivityFacts["view"]> {
  if (value === "list" || value === "grid" || value === "tree" || value === "auto") return value;
  throw Error("Invalid stored folder view");
}
export function activityMetadataUnchanged(
  action: PersonalActivityAction,
  before: ActivityFacts,
  after: ActivityFacts,
  absent: boolean,
) {
  if (action === "tag.delete" || action === "folder.view.reset") return absent;
  if (action === "file.favorite.set") return before.favorite === after.favorite;
  if (action === "folder.view.set") return before.view === after.view;
  if (action === "file.tags.set" || action === "tag.update")
    return (
      JSON.stringify([...(before.tags ?? [])].sort((a, b) => a.id.localeCompare(b.id))) ===
      JSON.stringify([...(after.tags ?? [])].sort((a, b) => a.id.localeCompare(b.id)))
    );
  return false;
}
