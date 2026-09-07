import { baseName, extensionOf } from "@fdrive/core";

const NS_PER_MS = 1_000_000n;

/**
 * Best-effort guess at whether a move destination is a file or a folder,
 * from its path alone (SFTPGo's move response and `idx.moves` rows carry no
 * entry kind): extensionless is treated as a folder, matching how fdrive's
 * own folder names are chosen in practice. Used to pick which live-read
 * check (`kind: "file"` vs `"dir"`) authorizes a move's destination.
 */
export function moveDestinationKind(path: string): "file" | "dir" {
  return extensionOf(baseName(path)) === "" ? "dir" : "file";
}

/** Converts an ISO-ish date string to nanoseconds since epoch (as the indexer stores mtimes), `undefined` for an absent or unparsable value. */
export function nsFromIso(value: string | undefined): bigint | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return BigInt(date.getTime()) * NS_PER_MS;
}

/** Converts `mtimeNs` (nanoseconds since epoch) to an ISO string, matching `@fdrive/db`'s stored precision (truncated to ms). */
export function isoFromNs(mtimeNs: bigint): string {
  return new Date(Number(mtimeNs / NS_PER_MS)).toISOString();
}

/** Normalizes a user-supplied extension to lowercase with a leading dot, `undefined` for an empty value. */
export function normalizeExtArg(ext: string | undefined): string | undefined {
  if (ext === undefined || ext.trim().length === 0) {
    return undefined;
  }
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Groups a virtual path into the folder key `folder_overview` aggregates by:
 * segments truncated to `prefixDepth + depth` levels, or the file's own
 * parent when it is shallower than that. Mirrors filesai's `folder_overview`
 * grouping, adapted to fdrive's leading-slash virtual paths.
 */
export function overviewFolderKey(prefixDepth: number, depth: number, virtualPath: string): string {
  const segments = virtualPath === "/" ? [] : virtualPath.slice(1).split("/");
  const cut = prefixDepth + depth;
  const keySegments = segments.length > cut ? segments.slice(0, cut) : segments.slice(0, -1);
  return keySegments.length === 0 ? "/" : `/${keySegments.join("/")}`;
}

/** The number of segments in a normalized virtual path prefix ("/" has 0). */
export function pathDepth(virtualPath: string): number {
  return virtualPath === "/" ? 0 : virtualPath.slice(1).split("/").length;
}

/** Slices `text` for `read_file_text`'s paging, clamping `maxChars` to a sane range. */
export function pageText(
  text: string,
  offset: number,
  maxChars: number,
): { slice: string; totalChars: number; hasMore: boolean } {
  const clampedMax = Math.max(200, Math.min(maxChars, 40_000));
  const clampedOffset = Math.max(0, offset);
  const slice = text.slice(clampedOffset, clampedOffset + clampedMax);
  return {
    slice,
    totalChars: text.length,
    hasMore: clampedOffset + clampedMax < text.length,
  };
}
