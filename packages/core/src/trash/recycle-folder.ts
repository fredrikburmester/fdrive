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

export interface ParsedTrashLeaf {
  readonly originalPath: string;
  readonly name: string;
  readonly deletedAt: Date;
}

export type RecycleFolderLayout = "native" | "move";
export type MoveTrashLeafKind = "file" | "dir";

const MOVE_LAYOUT_NAMESPACE = ".fdrive-move-v1";

export function moveTrashRootPath(trashPath: string): string {
  return normalizePath(`${normalizePath(trashPath)}/${MOVE_LAYOUT_NAMESPACE}`);
}

/**
 * Parses a full storage path to a trash leaf (the recycle folder's layout is
 * `<trashPath>/<original dir>/<original name>/<nanosecond timestamp>`).
 * Returns `null` for anything that is not a well-formed leaf under
 * `trashPath`: the leaf name must be 1 to 20 ASCII digits, and there must be
 * at least one more segment above it (the original item's name).
 */
export function parseTrashLeaf(trashPath: string, leafPath: string): ParsedTrashLeaf | null {
  const trashRoot = normalizePath(trashPath);
  const leaf = normalizePath(leafPath);
  if (!isUnderPath(trashRoot, leaf)) {
    return null;
  }
  // isUnderPath just confirmed leaf is nested under trashRoot, so
  // relativeTo always succeeds here; the cast works around
  // noUncheckedIndexedAccess not knowing that.
  const relative = relativeTo(trashRoot, leaf) as string;
  const segments = relative.split("/");
  if (segments.length < 2) {
    return null;
  }
  // Neither segment came from an empty split chunk (normalizePath never
  // produces one), and segments.length >= 2 was just checked, so both
  // indexed reads below are always defined; the casts work around
  // noUncheckedIndexedAccess not knowing that.
  const timestamp = segments[segments.length - 1] as string;
  if (!LEAF_NAME_PATTERN.test(timestamp)) {
    return null;
  }
  const originalSegments = segments.slice(0, -1);
  const name = originalSegments[originalSegments.length - 1] as string;
  return {
    originalPath: `/${originalSegments.join("/")}`,
    name,
    deletedAt: new Date(Number(BigInt(timestamp) / BigInt(1_000_000))),
  };
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
 * Builds a generic move-wrapper leaf in a versioned namespace. Alternating
 * `p/<raw segment>` pairs distinguish original path data from layout markers
 * without encoding or reserving any user filename.
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

export interface ParsedMoveTrashLeaf extends ParsedTrashLeaf {
  readonly kind: MoveTrashLeafKind;
}

/** Parses only the versioned, structurally unambiguous generic move layout. */
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
