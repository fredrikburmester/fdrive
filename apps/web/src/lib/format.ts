/** Options for {@link formatBytes}. */
export interface FormatBytesOptions {
  readonly locale?: string;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Formats a byte count as a human-readable string: "0 B" for zero or
 * negative values, a whole number of bytes below 1 KB, and one decimal
 * place for KB and above (e.g. "1.5 KB", "3.0 MB").
 */
export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  if (bytes <= 0) {
    return "0 B";
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const unit = BYTE_UNITS[unitIndex] ?? "TB";

  if (unit === "B") {
    return `${Math.round(value).toLocaleString(opts.locale)} B`;
  }

  const formatted = value.toLocaleString(opts.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${unit}`;
}

/** Options for {@link formatDate}. */
export interface FormatDateOptions {
  readonly now?: Date;
  readonly locale?: string;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Formats a date relative to `opts.now` (defaults to the current time):
 * "Today 14:05" for the same calendar day, "Yesterday 09:12" for the day
 * before, and a short date (e.g. "Jan 5" or "Jan 5, 2024" when the year
 * differs from `now`) for anything older. Deterministic given `now`.
 */
export function formatDate(date: Date, opts: FormatDateOptions = {}): string {
  const now = opts.now ?? new Date();

  if (isSameCalendarDay(date, now)) {
    return `Today ${formatTime(date)}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) {
    return `Yesterday ${formatTime(date)}`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };

  return date.toLocaleDateString(opts.locale, options);
}
