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

/**
 * The kinds of failure a `StorageProvider` can raise, shared by every
 * provider implementation (SFTPGo today, others later) so callers such as
 * `apps/api` can map them to HTTP responses without knowing which provider
 * backs a given identity.
 */
export type StorageErrorKind =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "bad_request"
  | "upstream_unavailable"
  | "unauthorized"
  | "internal";

/**
 * The single error type thrown by every `StorageProvider` implementation.
 * `cause` carries the underlying provider error (for logging) and
 * `details` carries machine-readable context such as the provider's own
 * error detail string. Consumers should narrow with `isStorageError` rather
 * than `instanceof StorageError` across package or bundler boundaries.
 */
export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  override readonly cause?: unknown;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: StorageErrorKind,
    message: string,
    opts?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    if (opts?.cause !== undefined) {
      this.cause = opts.cause;
    }
    if (opts?.details !== undefined) {
      this.details = opts.details;
    }
    // Restores the prototype chain when the class is transpiled down to a
    // target where `Error` subclassing loses it (older ES targets), so
    // `instanceof StorageError` keeps working.
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

/**
 * Type guard for `StorageError`. Prefer this over `instanceof` when the
 * value may have crossed a realm or bundling boundary.
 */
export function isStorageError(e: unknown): e is StorageError {
  return e instanceof StorageError;
}
