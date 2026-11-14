import { normalizePath, relativeTo, splitSegments } from "../paths.ts";

/** A trash leaf's name is 1 to 20 ASCII digits: a nanosecond epoch timestamp. */
const LEAF_NAME_PATTERN = /^[0-9]{1,20}$/;

/**
 * True when `path` is nested strictly below `prefix` (not equal to it). The
 * root ("/") is below nothing.
 */
export function isUnderPath(prefix: string, path: string): boolean {
  const normalizedPrefix = normalizePath(prefix);
  const normalizedPath = normalizePath(path);
  if (normalizedPrefix === "/") {
    return normalizedPath !== "/";
  }
  return normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export type MoveTrashLeafKind = "file" | "dir";

const MOVE_LAYOUT_NAMESPACE = ".fdrive-move-v1";

/**
 * True when `path` lies in fdrive's Trash layout under any folder: one of its
 * segments is the layout's namespace, in any case. It does not depend on
 * where Trash is set to be now, so a leaf in a Trash since turned off or
 * moved is still recognised.
 */
export function isInMoveTrashLayout(path: string): boolean {
  return splitSegments(normalizePath(path)).some(
    (segment) => segment.toLowerCase() === MOVE_LAYOUT_NAMESPACE,
  );
}

/** The versioned namespace under the trash folder that every leaf lives in. */
export function moveTrashRootPath(trashPath: string): string {
  return normalizePath(`${normalizePath(trashPath)}/${MOVE_LAYOUT_NAMESPACE}`);
}

/**
 * Builds the full storage path of the trash leaf identified by `id` (a
 * trash-relative path, without a leading slash, as returned in
 * `TrashEntry.id`).
 */
export function trashLeafPath(trashPath: string, id: string): string {
  return normalizePath(`${normalizePath(trashPath)}/${id}`);
}

/**
 * Builds the leaf a deleted item is moved to:
 * `<trashPath>/.fdrive-move-v1/<kind>/p/<segment>/…/v/<nanosecond timestamp>`.
 * Alternating `p/<raw segment>` pairs distinguish original path data from
 * layout markers without encoding or reserving any user filename.
 */
export function moveTrashLeafPath(
  trashPath: string,
  originalPath: string,
  kind: MoveTrashLeafKind,
  timestamp: string,
): string {
  const pathSegments = splitSegments(normalizePath(originalPath)).flatMap((segment) => [
    "p",
    segment,
  ]);
  return normalizePath(
    [normalizePath(trashPath), MOVE_LAYOUT_NAMESPACE, kind, ...pathSegments, "v", timestamp].join(
      "/",
    ),
  );
}

export interface ParsedMoveTrashLeaf {
  readonly kind: MoveTrashLeafKind;
  readonly originalPath: string;
  readonly name: string;
  readonly deletedAt: Date;
}

/**
 * Parses a full storage path back into the leaf `moveTrashLeafPath` built.
 * Returns `null` for anything else: a path outside the namespace, a
 * malformed structure, or a leaf name that is not 1 to 20 ASCII digits.
 */
export function parseMoveTrashLeaf(
  trashPath: string,
  leafPath: string,
): ParsedMoveTrashLeaf | null {
  const moveRoot = moveTrashRootPath(trashPath);
  const leaf = normalizePath(leafPath);
  if (!isUnderPath(moveRoot, leaf)) {
    return null;
  }
  const segments = (relativeTo(moveRoot, leaf) as string).split("/");
  const kind = segments[0];
  const timestamp = segments[segments.length - 1];
  if (
    (kind !== "file" && kind !== "dir") ||
    segments.length < 3 ||
    segments[segments.length - 2] !== "v" ||
    timestamp === undefined ||
    !LEAF_NAME_PATTERN.test(timestamp)
  ) {
    return null;
  }
  const encodedPath = segments.slice(1, -2);
  if (encodedPath.length % 2 !== 0) {
    return null;
  }
  const originalSegments: string[] = [];
  for (let index = 0; index < encodedPath.length; index += 2) {
    if (encodedPath[index] !== "p" || encodedPath[index + 1] === undefined) {
      return null;
    }
    originalSegments.push(encodedPath[index + 1] as string);
  }
  if (originalSegments.length === 0) {
    return null;
  }
  const name = originalSegments[originalSegments.length - 1] as string;
  return {
    kind,
    originalPath: `/${originalSegments.join("/")}`,
    name,
    deletedAt: new Date(Number(BigInt(timestamp) / BigInt(1_000_000))),
  };
}
