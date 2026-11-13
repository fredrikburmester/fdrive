import { isAbsolute, relative, sep } from "node:path";

/**
 * What an upload published: its bytes' digest and the file it became. A
 * client chooses the modification time, so the inode and the change time,
 * which no client can set, are what tie the digest to this file and no other.
 */
export interface DiskContent {
  readonly sha256: string;
  readonly size: number;
  /** Nanoseconds since the epoch, as `stat` reports them (`st_mtim`). */
  readonly mtimeNs: bigint;
  readonly ino: bigint;
  /** The change time once published, in nanoseconds (`st_ctim`). */
  readonly ctimeNs: bigint;
}

/**
 * A change storage made on disk, by absolute path. `changed`: something at
 * `path` is new, different or gone (a file, a folder, or nothing any more);
 * `content` is set for an upload. `moved`: `path` was renamed to `target`.
 */
export type DiskChange =
  | { readonly kind: "changed"; readonly path: string; readonly content?: DiskContent }
  | { readonly kind: "moved"; readonly path: string; readonly target: string };

/** Hears each change once it is done. It must not throw; if it does, the change still stands. */
export type DiskChangeListener = (change: DiskChange) => void;

/** Tells `listener` about `change`, if there is a listener, never failing the caller. */
export function notify(listener: DiskChangeListener | undefined, change: DiskChange): void {
  if (listener === undefined) return;
  try {
    listener(change);
  } catch {
    // The change already happened; a listener cannot undo it or fail it.
  }
}

/**
 * A change under an index root, by the root-relative path the indexer stores
 * (`alice/docs/a.pdf`: `/` separators, no leading slash). Otherwise the same
 * as `DiskChange`.
 */
export type IndexChange =
  | { readonly kind: "changed"; readonly path: string; readonly content?: DiskContent }
  | { readonly kind: "moved"; readonly path: string; readonly target: string };

/** `path` relative to `root` (both absolute and real), or `null` when it is not below it. */
export function relativeTo(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * `change` as the indexer of `root` sees it, or `null` when it happened
 * elsewhere. A move with one side outside the root is a change to the other
 * side: the files left the root, or arrived in it.
 */
export function underRoot(root: string, change: DiskChange): IndexChange | null {
  const path = relativeTo(root, change.path);
  if (change.kind === "changed") {
    if (path === null) return null;
    return change.content === undefined
      ? { kind: "changed", path }
      : { kind: "changed", path, content: change.content };
  }
  const target = relativeTo(root, change.target);
  if (path !== null && target !== null) return { kind: "moved", path, target };
  if (path !== null) return { kind: "changed", path };
  if (target !== null) return { kind: "changed", path: target };
  return null;
}
