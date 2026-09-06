/** Formats an ISO instant as a plain `YYYY-MM-DD` date, stable across locales and timezones-in-tests. */
export function formatShortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Formats a nullable ISO instant (`lastUsedAt`, `expiresAt`), using `fallback` for `null`. */
export function formatOptionalTimestamp(iso: string | null, fallback: string): string {
  return iso === null ? fallback : formatShortDate(iso);
}

/** `token.lastUsedAt`, formatted for the tokens table. */
export function formatLastUsed(iso: string | null): string {
  return formatOptionalTimestamp(iso, "Never");
}

/** `token.expiresAt`, formatted for the tokens table. */
export function formatExpires(iso: string | null): string {
  return formatOptionalTimestamp(iso, "Never");
}
