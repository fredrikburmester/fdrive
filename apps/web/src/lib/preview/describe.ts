import type { FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { formatBytes } from "../format";
import { previewKindFor } from "./kind";

export interface DescribeRow {
  readonly label: string;
  readonly value: string;
}

export interface DescribeEntryOptions {
  readonly now: Date;
  readonly locale?: string;
}

export interface DescribeEntryResult {
  readonly rows: DescribeRow[];
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

/**
 * Builds the inspector's description rows for a single entry: Kind, Size,
 * Modified (an absolute timestamp plus a relative one), Location (the
 * parent path), and Extension.
 */
export function describeEntry(entry: FsEntry, opts: DescribeEntryOptions): DescribeEntryResult {
  const modifiedDate = new Date(entry.modifiedAt);
  const absolute = modifiedDate.toLocaleString(opts.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const relative = relativeTimeFrom(modifiedDate, opts.now, opts.locale);

  return {
    rows: [
      { label: "Kind", value: kindLabel(entry) },
      {
        label: "Size",
        value: formatBytes(entry.size, opts.locale === undefined ? {} : { locale: opts.locale }),
      },
      { label: "Modified", value: `${absolute} (${relative})` },
      { label: "Location", value: parentPath(entry.path) },
      { label: "Extension", value: entry.ext.length > 0 ? entry.ext : "—" },
    ],
  };
}
