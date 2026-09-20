import { randomUUID } from "node:crypto";
import type { ActivityFacts, ActivitySubject } from "@fdrive/contracts";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import {
  activityEventSubjects,
  activityFileBridges,
  activityFileLocations,
  activityFiles,
  activityTrashBindings,
} from "../schema/activity.js";
import type {
  ActivityDb,
  ActivityFileRecord,
  ActivityFinish,
  ActivityOperationRecord,
} from "./activity-types.js";
import { requireActivityRow } from "./activity-types.js";

export function escapeActivityLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function activityFingerprint(facts: ActivityFacts): string | null {
  if (facts.size !== undefined && facts.modifiedAt)
    return `stat:${JSON.stringify([facts.size, facts.modifiedAt])}`;
  if (facts.sha256) return `sha256:${facts.sha256}`;
  return facts.version ? `version:${facts.version}` : null;
}
export async function lockActivityRegistry(db: ActivityDb, identityId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`activity-files:${identityId}`},0))`,
  );
}
export async function activityFileAt(
  db: ActivityDb,
  identityId: string,
  path: string,
): Promise<ActivityFileRecord | null> {
  return (
    (
      await db
        .select()
        .from(activityFiles)
        .where(
          and(
            eq(activityFiles.identityId, identityId),
            eq(activityFiles.path, path),
            eq(activityFiles.state, "live"),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}
export async function ensureActivityFile(
  db: ActivityDb,
  identityId: string,
  path: string,
  kind: "file" | "dir",
  now: Date,
): Promise<ActivityFileRecord>;
export async function ensureActivityFile(
  db: ActivityDb,
  identityId: string,
  path: string,
  kind: "file" | "dir" | undefined,
  now: Date,
): Promise<ActivityFileRecord | null>;
export async function ensureActivityFile(
  db: ActivityDb,
  identityId: string,
  path: string,
  kind: "file" | "dir" | undefined,
  now: Date,
): Promise<ActivityFileRecord | null> {
  const prior = await activityFileAt(db, identityId, path);
  // Metadata and multi-path reads may know only the path. Preserve established
  // identity, and leave new subjects unbound until storage establishes their kind.
  if (!kind) return prior;
  if (prior && prior.kind === kind) return prior;
  if (prior) await retireActivityPath(db, identityId, path, "deleted", now);
  const [fileRow] = await db
    .insert(activityFiles)
    .values({ identityId, path, kind, firstObservedAt: now, lastConfirmedAt: now })
    .returning();
  const file = requireActivityRow(fileRow, "Activity file was not inserted");
  await db
    .insert(activityFileLocations)
    .values({ fileId: file.id, identityId, path, generation: 0, validFrom: now });
  return file;
}
function prefix(identityId: string, path: string) {
  return and(
    eq(activityFiles.identityId, identityId),
    eq(activityFiles.state, "live"),
    or(eq(activityFiles.path, path), like(activityFiles.path, `${escapeActivityLike(path)}/%`)),
  );
}
async function closeLocations(db: ActivityDb, file: ActivityFileRecord, now: Date) {
  await db
    .update(activityFileLocations)
    .set({ validUntil: now })
    .where(
      and(eq(activityFileLocations.fileId, file.id), isNull(activityFileLocations.validUntil)),
    );
}
export async function retireActivityPath(
  db: ActivityDb,
  identityId: string,
  path: string,
  state: "trashed" | "deleted" | "unknown",
  now: Date,
): Promise<ActivityFileRecord[]> {
  const files = await db.select().from(activityFiles).where(prefix(identityId, path));
  for (const file of files) {
    await closeLocations(db, file, now);
    await db
      .update(activityFiles)
      .set({ state, generation: file.generation + 1, lastConfirmedAt: now })
      .where(eq(activityFiles.id, file.id));
  }
  return files;
}
export function activitySubject(
  file: ActivityFileRecord,
  role: ActivitySubject["role"],
  ordinal = 0,
): ActivitySubject {
  return {
    fileId: file.id,
    identityId: file.identityId,
    role,
    ordinal,
    path: file.path,
    revisionId: file.revisionId,
  };
}

export interface ActivityRegistryResult {
  file: ActivityFileRecord | null;
  source: ActivityFileRecord | null;
  subjects: ActivitySubject[];
  revisionId: string | null;
  copies?: { source: ActivityFileRecord; target: ActivityFileRecord }[];
}
/** Called only after confirmed provider success, inside the outcome transaction. */
export async function applyActivityOutcome(
  db: ActivityDb,
  operation: ActivityOperationRecord,
  result: ActivityFinish,
  now: Date,
): Promise<ActivityRegistryResult> {
  const { identityId, action } = operation;
  const before = operation.before ?? operation.requested;
  const after = result.after ?? operation.requested;
  const path = before.path ?? operation.requested.path;
  const target = after.targetPath ?? after.path ?? operation.requested.targetPath ?? path;
  let file: ActivityFileRecord | null = null;
  let source: ActivityFileRecord | null = null;
  const subjects: ActivitySubject[] = [];
  const copies: { source: ActivityFileRecord; target: ActivityFileRecord }[] = [];
  if (!path || !target || ["trash.empty", "tag.update", "tag.delete"].includes(action))
    return { file, source, subjects, revisionId: null };
  // A delayed receipt establishes historical success, not the current location.
  // Never roll a registry entry back across a newer confirmed mutation.
  if (operation.fileId) {
    const captured = (
      await db.select().from(activityFiles).where(eq(activityFiles.id, operation.fileId))
    )[0];
    if (
      captured &&
      operation.fileGeneration !== null &&
      captured.generation !== operation.fileGeneration
    ) {
      if (action === "file.copy")
        return {
          file: null,
          source: captured,
          subjects: [
            activitySubject(captured, "source"),
            {
              fileId: null,
              identityId,
              path: target,
              role: "target",
              ordinal: 1,
              revisionId: null,
            },
          ],
          revisionId: null,
        };
      return {
        file: captured,
        source: captured,
        subjects: [
          {
            ...activitySubject(captured, "primary"),
            path: target,
            revisionId: operation.revisionId,
          },
        ],
        revisionId: null,
      };
    }
  } else {
    const occupant = await activityFileAt(db, identityId, target);
    if (occupant && occupant.lastConfirmedAt > operation.createdAt)
      return {
        file: null,
        source: null,
        subjects: [
          { fileId: null, identityId, path: target, role: "primary", ordinal: 0, revisionId: null },
        ],
        revisionId: null,
      };
  }
  if (action === "file.delete" && operation.requested.trashLeaf) {
    const binding = (
      await db
        .select()
        .from(activityTrashBindings)
        .where(
          and(
            eq(activityTrashBindings.identityId, identityId),
            eq(activityTrashBindings.trashLeaf, operation.requested.trashLeaf),
            eq(activityTrashBindings.state, "bound"),
          ),
        )
        .limit(1)
    )[0];
    if (!binding) return { file, source, subjects, revisionId: null };
    const members = await db
      .select({ file: activityFiles })
      .from(activityEventSubjects)
      .innerJoin(activityFiles, eq(activityFiles.id, activityEventSubjects.fileId))
      .where(
        and(eq(activityEventSubjects.eventId, binding.eventId), eq(activityFiles.state, "trashed")),
      );
    for (const { file: member } of members) {
      await db
        .update(activityFiles)
        .set({ state: "deleted", generation: member.generation + 1, lastConfirmedAt: now })
        .where(eq(activityFiles.id, member.id));
      subjects.push(activitySubject(member, "affected", subjects.length));
      if (member.id === binding.fileId) file = member;
    }
    await db
      .update(activityTrashBindings)
      .set({ state: "purged" })
      .where(eq(activityTrashBindings.eventId, binding.eventId));
    return { file, source, subjects, revisionId: null };
  }
  if (action === "file.restore" && operation.requested.trashLeaf) {
    const binding = (
      await db
        .select()
        .from(activityTrashBindings)
        .where(
          and(
            eq(activityTrashBindings.identityId, identityId),
            eq(activityTrashBindings.trashLeaf, operation.requested.trashLeaf),
            eq(activityTrashBindings.state, "bound"),
          ),
        )
        .limit(1)
    )[0];
    if (binding) {
      file =
        (await db.select().from(activityFiles).where(eq(activityFiles.id, binding.fileId)))[0] ??
        null;
      await db
        .update(activityTrashBindings)
        .set({ state: "restored" })
        .where(eq(activityTrashBindings.eventId, binding.eventId));
      if (file) {
        await retireActivityPath(db, identityId, target, "deleted", now);
        const members = await db
          .select({ file: activityFiles })
          .from(activityEventSubjects)
          .innerJoin(activityFiles, eq(activityFiles.id, activityEventSubjects.fileId))
          .where(
            and(
              eq(activityEventSubjects.eventId, binding.eventId),
              eq(activityEventSubjects.role, "affected"),
              eq(activityFiles.state, "trashed"),
            ),
          );
        for (const { file: member } of members) {
          const newPath = target + member.path.slice(binding.originalPath.length);
          const [updated] = await db
            .update(activityFiles)
            .set({
              path: newPath,
              state: "live",
              generation: member.generation + 1,
              lastConfirmedAt: now,
            })
            .where(eq(activityFiles.id, member.id))
            .returning();
          if (!updated) continue;
          await db.insert(activityFileLocations).values({
            fileId: updated.id,
            identityId,
            path: newPath,
            validFrom: now,
            generation: updated.generation,
          });
          subjects.push(activitySubject(updated, "affected", subjects.length));
          if (updated.id === file.id) file = updated;
        }
      }
    }
  }
  source = await activityFileAt(db, identityId, path);
  if (["file.move", "file.rename", "file.copy"].includes(action)) {
    source ??= await ensureActivityFile(
      db,
      identityId,
      path,
      before.kind ?? after.kind ?? "file",
      now,
    );
    subjects.push(activitySubject(source, "source"));
  }
  if (action === "file.copy") {
    await retireActivityPath(db, identityId, target, "deleted", now);
    file = await ensureActivityFile(
      db,
      identityId,
      target,
      after.kind ?? source?.kind ?? "file",
      now,
    );
    if (source?.kind === "dir") {
      const descendants = await db.select().from(activityFiles).where(prefix(identityId, path));
      for (const child of descendants) {
        if (child.id === source.id) continue;
        let targetFile = await ensureActivityFile(
          db,
          identityId,
          target + child.path.slice(path.length),
          child.kind,
          now,
        );
        if (targetFile.kind === "file") {
          const [updated] = await db
            .update(activityFiles)
            .set({ revisionId: randomUUID(), generation: targetFile.generation + 1 })
            .where(eq(activityFiles.id, targetFile.id))
            .returning();
          targetFile = updated ?? targetFile;
        }
        subjects.push(activitySubject(child, "source", subjects.length));
        subjects.push(activitySubject(targetFile, "target", subjects.length));
        copies.push({ source: child, target: targetFile });
      }
    }
  } else if (action === "file.move" || action === "file.rename") {
    const moved = await db.select().from(activityFiles).where(prefix(identityId, path));
    if (path !== target) await retireActivityPath(db, identityId, target, "deleted", now);
    for (const entry of moved) {
      const newPath = target + entry.path.slice(path.length);
      await closeLocations(db, entry, now);
      const [updated] = await db
        .update(activityFiles)
        .set({ path: newPath, generation: entry.generation + 1, lastConfirmedAt: now })
        .where(eq(activityFiles.id, entry.id))
        .returning();
      if (!updated) continue;
      await db.insert(activityFileLocations).values({
        fileId: updated.id,
        identityId,
        path: newPath,
        generation: updated.generation,
        validFrom: now,
      });
      subjects.push(
        activitySubject(updated, entry.path === path ? "target" : "affected", subjects.length),
      );
      if (entry.path === path) file = updated;
    }
  } else if (action === "file.trash" || action === "file.delete") {
    file = source ?? (await ensureActivityFile(db, identityId, path, before.kind ?? "file", now));
    const retired = await retireActivityPath(
      db,
      identityId,
      path,
      action === "file.trash" ? "trashed" : "deleted",
      now,
    );
    subjects.push(...retired.map((entry, ordinal) => activitySubject(entry, "affected", ordinal)));
  } else {
    // Successful creation establishes a kind even for older producers that
    // omitted it. Reads, shares and metadata cannot establish one from a path.
    const createdKind = ["file.create", "file.upload", "file.save"].includes(action)
      ? "file"
      : action === "folder.create"
        ? "dir"
        : undefined;
    file ??= await ensureActivityFile(
      db,
      identityId,
      target,
      after.kind ?? before.kind ?? createdKind,
      now,
    );
  }
  const revisionId =
    file?.kind === "file" &&
    ["file.upload", "file.create", "file.save", "file.copy"].includes(action)
      ? randomUUID()
      : null;
  if (file && revisionId) {
    const [updated] = await db
      .update(activityFiles)
      .set({
        revisionId,
        generation: file.generation + 1,
        fingerprint: activityFingerprint(after),
        lastConfirmedAt: now,
      })
      .where(eq(activityFiles.id, file.id))
      .returning();
    file = updated ?? file;
  }
  if (file && result.bridge) {
    await db
      .insert(activityFileBridges)
      .values({ identityId, fileId: file.id, ...result.bridge })
      .onConflictDoUpdate({
        target: [
          activityFileBridges.identityId,
          activityFileBridges.namespace,
          activityFileBridges.externalId,
        ],
        set: { fileId: file.id },
      });
  }
  if (file && !subjects.some((subject) => subject.fileId === file.id && subject.role !== "source"))
    subjects.push(activitySubject(file, "primary"));
  return { file, source, subjects, revisionId, copies };
}
