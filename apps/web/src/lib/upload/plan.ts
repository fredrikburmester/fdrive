import { joinPath } from "@fdrive/core";
import type { DroppedFile } from "./traverse.js";
import type { UploadItem } from "./types.js";

export type ConflictPolicy = "replace" | "skip" | "ask";

export interface PlanUploadsResult {
  readonly items: UploadItem[];
  /** Deduped top-level names in `files` that already exist at `destination`. */
  readonly conflicts: string[];
}

/** The first path segment of a "/"-separated relative path. */
function topLevelName(relativePath: string): string {
  const slash = relativePath.indexOf("/");
  return slash === -1 ? relativePath : relativePath.slice(0, slash);
}

/**
 * Turns dropped or selected files into `UploadItem`s targeting `destination`,
 * detecting name collisions with `existingNames` (the current listing's
 * entry names). Collisions are reported as `conflicts` (deduped top-level
 * names) and, under the "skip" policy, the colliding items are queued with
 * status "skipped" rather than "queued". "replace" and "ask" leave every
 * item queued; "ask" is for the caller to prompt the user and re-plan with
 * a definite policy before enqueuing.
 */
export function planUploads(
  files: readonly DroppedFile[],
  destination: string,
  existingNames: ReadonlySet<string>,
  policy: ConflictPolicy,
  createId: () => string,
): PlanUploadsResult {
  const conflictSet = new Set<string>();
  const items: UploadItem[] = [];

  for (const { file, relativePath } of files) {
    const topName = topLevelName(relativePath);
    const isConflict = existingNames.has(topName);
    if (isConflict) {
      conflictSet.add(topName);
    }

    items.push({
      id: createId(),
      file,
      targetPath: joinPath(destination, relativePath),
      relativePath,
      size: file.size,
      status: policy === "skip" && isConflict ? "skipped" : "queued",
      progress: 0,
      attempts: 0,
    });
  }

  return { items, conflicts: Array.from(conflictSet) };
}
