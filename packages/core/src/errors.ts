/**
 * The kinds of error every `@fdrive/core` function can raise. Kept as a
 * closed union so callers can switch on it exhaustively.
 */
export type CoreErrorKind =
  | "invalid_path"
  | "out_of_scope"
  | "invalid_template"
  | "invalid_argument";

/**
 * The single error type thrown by this package. Every throw site picks one
 * of the `CoreErrorKind` values and may attach machine-readable `details`
 * for logging or tests. Consumers should narrow with `isCoreError` rather
 * than `instanceof CoreError` across package or bundler boundaries.
 */
export class CoreError extends Error {
  readonly kind: CoreErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: CoreErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CoreError";
    this.kind = kind;
    if (details !== undefined) {
      this.details = details;
    }
    // Restores the prototype chain when the class is transpiled down to a
    // target where `Error` subclassing loses it (older ES targets), so
    // `instanceof CoreError` keeps working.
    Object.setPrototypeOf(this, CoreError.prototype);
  }
}

/**
 * Type guard for `CoreError`. Prefer this over `instanceof` when the value
 * may have crossed a realm or bundling boundary.
 */
export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}
