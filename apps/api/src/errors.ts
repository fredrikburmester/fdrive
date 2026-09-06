import type { ApiError, ApiErrorKind } from "@fdrive/contracts";

/**
 * Thrown by route handlers to signal a specific API error kind. The error
 * handler in `app.ts` turns instances of this class into the `ApiError`
 * contract shape with the matching HTTP status.
 */
export class ApiHttpError extends Error {
  readonly kind: ApiErrorKind;
  readonly details: Record<string, unknown> | undefined;

  constructor(kind: ApiErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiHttpError";
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Builds an `ApiError` contract payload. `requestId` and `details` are
 * attached only when present, so the result never sets either field to
 * `undefined` explicitly.
 */
export function toApiError(
  kind: ApiErrorKind,
  message: string,
  requestId?: string,
  details?: Record<string, unknown>,
): ApiError {
  return {
    error: {
      kind,
      message,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  };
}
