export type ParseDatabaseUrlResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const VALID_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/**
 * Validates that a connection string is a `postgres://` or `postgresql://`
 * URL with a database name in its path. Pure validation only: it never
 * connects, and on success returns the original string unchanged so callers
 * can pass it straight to a pg Pool.
 */
export function parseDatabaseUrl(url: string): ParseDatabaseUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (!VALID_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `unsupported protocol "${parsed.protocol}", expected "postgres:" or "postgresql:"`,
    };
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (database.length === 0) {
    return { ok: false, reason: "missing database name" };
  }

  return { ok: true, value: url };
}
