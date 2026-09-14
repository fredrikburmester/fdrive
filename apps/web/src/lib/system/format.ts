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

/** Compact duration for API process uptime (not host or container uptime). */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${Math.floor(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days === 0) return `${hours}h ${minutes % 60}m`;
  return `${days}d ${hours % 24}h ${minutes % 60}m`;
}
