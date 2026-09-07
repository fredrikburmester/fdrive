import type { FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { formatBytes } from "../format";
import { previewKindFor } from "./kind";

export interface DescribeRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The folder size query's state, as seen from `describeEntry`: a subset of
 * TanStack Query's `UseQueryResult<FolderSizeResponse>` shape, so callers
 * pass the hook's result directly without either side depending on the
 * other's types.
 */
export interface FolderSizeQueryState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data?: { readonly bytes: number; readonly files: number; readonly indexed: boolean };
}

export interface DescribeEntryOptions {
  readonly now: Date;
  readonly locale?: string;
  /**
   * The folder size query's current state, for a directory entry only.
   * Ignored for a file. Ordinarily rendered as a "Files" row alongside the
   * usual "Size" row; a not-indexed or still-loading result replaces
   * "Size"'s value instead of showing a byte count.
   */
  readonly folderSize?: FolderSizeQueryState;
}

export interface DescribeEntryResult {
  readonly rows: DescribeRow[];
  /** A one-line muted note about the folder size row, when indexed data is showing. */
  readonly note: string | null;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF Document",
  markdown: "Markdown Document",
  code: "Code File",
  text: "Text File",
  office: "Office Document",
  archive: "Archive",
};

/** A human label for the inspector's "Kind" row. */
export function kindLabel(entry: Pick<FsEntry, "kind" | "ext" | "mime" | "size">): string {
  if (entry.kind === "dir") {
    return "Folder";
  }
  if (entry.kind === "symlink") {
    return "Symlink";
  }
  if (entry.kind === "other") {
    return "File";
  }
  const previewKind = previewKindFor(entry);
  return KIND_LABELS[previewKind] ?? "File";
}

const RELATIVE_UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: "year", seconds: 60 * 60 * 24 * 365 },
  { unit: "month", seconds: 60 * 60 * 24 * 30 },
  { unit: "week", seconds: 60 * 60 * 24 * 7 },
  { unit: "day", seconds: 60 * 60 * 24 },
  { unit: "hour", seconds: 60 * 60 },
  { unit: "minute", seconds: 60 },
];

/**
 * A relative time string such as "3 hours ago" or "in 2 days", relative to
 * `now`. Falls back to "just now" for differences under a minute.
 */
export function relativeTimeFrom(date: Date, now: Date, locale?: string): string {
  const diffSeconds = (date.getTime() - now.getTime()) / 1000;
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < 60) {
    return "just now";
  }

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const { unit, seconds } of RELATIVE_UNITS) {
    if (absSeconds >= seconds) {
      const value = Math.round(diffSeconds / seconds);
      return formatter.format(value, unit);
    }
  }
  // Unreachable: RELATIVE_UNITS' smallest threshold (minute, 60s) always
  // matches once absSeconds >= 60, which is guaranteed by the guard above.
  // Kept only so the function has a total return type.
  /* v8 ignore next */
  return "just now";
}

const localeOpts = (locale: string | undefined) => (locale === undefined ? {} : { locale });

/**
 * Builds the "Size" and "Files" rows plus the note text for a directory
 * entry, from `folderSize`'s query state: "Calculating" while the request
 * is in flight, "Not indexed" when it failed or came back `indexed: false`,
 * or a real byte count and file count once it resolves.
 */
function folderSizeRows(
  folderSize: FolderSizeQueryState,
  locale: string | undefined,
): { size: string; files: string; note: string | null } {
  if (folderSize.isPending) {
    return { size: "Calculating", files: "Calculating", note: null };
  }
  if (folderSize.isError || folderSize.data === undefined || !folderSize.data.indexed) {
    return { size: "Not indexed", files: "Not indexed", note: null };
  }
  return {
    size: formatBytes(folderSize.data.bytes, localeOpts(locale)),
    files: folderSize.data.files.toLocaleString(locale),
    note: "From the index",
  };
}

/**
 * Builds the inspector's description rows for a single entry: Kind, Size,
 * Modified (an absolute timestamp plus a relative one), Location (the
 * parent path), and Extension. For a directory whose `opts.folderSize` is
 * given, "Size" reflects that query's state instead of `entry.size` (which
 * storage providers never populate for a directory) and a "Files" row is
 * inserted right after it.
 */
export function describeEntry(entry: FsEntry, opts: DescribeEntryOptions): DescribeEntryResult {
  const modifiedDate = new Date(entry.modifiedAt);
  const absolute = modifiedDate.toLocaleString(opts.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const relative = relativeTimeFrom(modifiedDate, opts.now, opts.locale);

  let sizeValue = formatBytes(entry.size, localeOpts(opts.locale));
  let note: string | null = null;
  const extraRows: DescribeRow[] = [];

  if (entry.kind === "dir" && opts.folderSize !== undefined) {
    const folder = folderSizeRows(opts.folderSize, opts.locale);
    sizeValue = folder.size;
    note = folder.note;
    extraRows.push({ label: "Files", value: folder.files });
  }

  const sizeRow: DescribeRow = { label: "Size", value: sizeValue };

  return {
    rows: [
      { label: "Kind", value: kindLabel(entry) },
      sizeRow,
      ...extraRows,
      { label: "Modified", value: `${absolute} (${relative})` },
      { label: "Location", value: parentPath(entry.path) },
      { label: "Extension", value: entry.ext.length > 0 ? entry.ext : "—" },
    ],
    note,
  };
}
