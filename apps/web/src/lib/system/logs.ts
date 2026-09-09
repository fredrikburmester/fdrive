import type { SystemLogEntry, SystemLogLevel, SystemLogSubsystem } from "@fdrive/contracts";

/** Filter choices offered by the log sheet, each a minimum level for the API. */
export const LOG_LEVEL_FILTERS: ReadonlyArray<{ value: SystemLogLevel; label: string }> = [
  { value: "info", label: "All" },
  { value: "warn", label: "Warnings" },
  { value: "error", label: "Errors" },
];

/** `HH:MM:SS` in the viewer's local time, the only part of `at` a reader scans. */
export function formatLogTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Renders entries as plain lines for the clipboard and the `.txt` download:
 * the full ISO timestamp (local time is fine on screen, not in a file
 * someone pastes into a bug report), the level padded to a column, the
 * message, and the attached data as one-line JSON when present.
 */
export function formatLogLines(entries: readonly SystemLogEntry[]): string[] {
  return entries.map((entry) => {
    const head = `${entry.at}  ${entry.level.toUpperCase().padEnd(5)}  ${entry.message}`;
    return entry.data === undefined ? head : `${head}  ${JSON.stringify(entry.data)}`;
  });
}

/** Newline-delimited JSON, one entry per line, for the `.ndjson` download. */
export function toNdjson(entries: readonly SystemLogEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

/** `fdrive-indexer-logs-2026-09-09.txt`; the date keeps repeated downloads apart. */
export function logFileName(
  subsystem: SystemLogSubsystem,
  format: "txt" | "ndjson",
  now: Date,
): string {
  return `fdrive-${subsystem}-logs-${now.toISOString().slice(0, 10)}.${format}`;
}
