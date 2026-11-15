/** The Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = "23505";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * True when `error` is a Postgres unique-constraint violation. node-postgres
 * throws the raw driver error with `.code` set directly, but Drizzle wraps
 * it in its own `DrizzleQueryError` with the driver error attached as
 * `.cause`, so both shapes are checked.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (hasCode(error, UNIQUE_VIOLATION_CODE)) {
    return true;
  }
  const cause =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return hasCode(cause, UNIQUE_VIOLATION_CODE);
}
