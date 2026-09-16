/**
 * How byte counts scale: "binary" counts 1,024 bytes per KB (as Windows
 * does), "decimal" counts 1,000 bytes per kB (as macOS and SI do).
 */
export type SizeUnits = "binary" | "decimal";

/** Options for {@link formatBytes}. */
export interface FormatBytesOptions {
  readonly locale?: string;
  /** Defaults to "binary". */
  readonly units?: SizeUnits;
}

const BINARY_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * Formats a byte count as a human-readable string: "0 B" for zero or
 * negative values, a whole number of bytes below the first unit, and one
 * decimal place above it (e.g. "1.5 KB", "3.0 MB"). Binary units step by
 * 1,024 and are labelled "KB"; decimal units step by 1,000 and are
 * labelled "kB".
 */
export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  if (bytes <= 0) {
    return "0 B";
  }

  const decimal = opts.units === "decimal";
  const labels = decimal ? DECIMAL_UNITS : BINARY_UNITS;
  const step = decimal ? 1000 : 1024;

  let value = bytes;
  let unitIndex = 0;
  while (value >= step && unitIndex < labels.length - 1) {
    value /= step;
    unitIndex++;
  }

  const unit = labels[unitIndex] ?? "TB";

  if (unit === "B") {
    return `${Math.round(value).toLocaleString(opts.locale)} B`;
  }

  const formatted = value.toLocaleString(opts.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${unit}`;
}

/** "relative" says Today and Yesterday; "absolute" always shows the date and time. */
export type DateStyle = "relative" | "absolute";

/** "24h" renders 21:05; "12h" renders 9:05 PM. */
export type ClockFormat = "24h" | "12h";

/** Options for {@link formatDate}. */
export interface FormatDateOptions {
  readonly now?: Date;
  readonly locale?: string;
  /** Defaults to "relative". */
  readonly style?: DateStyle;
  /** Defaults to "24h". */
  readonly clock?: ClockFormat;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "09:05" on a 24-hour clock, or the locale's 12-hour rendering ("9:05 AM"). */
export function formatTime(date: Date, clock: ClockFormat = "24h", locale?: string): string {
  if (clock === "12h") {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12: true });
  }
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function shortDate(date: Date, now: Date, locale: string | undefined): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return date.toLocaleDateString(locale, options);
}

/**
 * Formats a date relative to `opts.now` (defaults to the current time). In
 * the default "relative" style: "Today 14:05" for the same calendar day,
 * "Yesterday 09:12" for the day before, and a short date (e.g. "Jan 5" or
 * "Jan 5, 2024" when the year differs from `now`) for anything older. The
 * "absolute" style always renders that short date followed by the time.
 * Deterministic given `now`.
 */
export function formatDate(date: Date, opts: FormatDateOptions = {}): string {
  const now = opts.now ?? new Date();
  const time = formatTime(date, opts.clock, opts.locale);

  if (opts.style === "absolute") {
    return `${shortDate(date, now, opts.locale)} ${time}`;
  }

  if (isSameCalendarDay(date, now)) {
    return `Today ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) {
    return `Yesterday ${time}`;
  }

  return shortDate(date, now, opts.locale);
}
