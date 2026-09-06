const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats the difference between `target` and `now` as a short relative
 * string: "just now" for anything under a minute, then minutes, hours, or
 * days, past ("5m ago") or future ("in 5m") depending on the sign of the
 * difference. Used for "Last updated", "last scan", and "next run" captions
 * across the System pages.
 */
export function formatRelativeTime(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < MINUTE_MS) {
    return "just now";
  }

  let value: number;
  let unit: string;
  if (absMs < HOUR_MS) {
    value = Math.floor(absMs / MINUTE_MS);
    unit = "m";
  } else if (absMs < DAY_MS) {
    value = Math.floor(absMs / HOUR_MS);
    unit = "h";
  } else {
    value = Math.floor(absMs / DAY_MS);
    unit = "d";
  }

  return diffMs < 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}
