import { z } from "zod";

/**
 * The set of error categories the API can report. Every thrown API error is
 * classified into one of these kinds, which in turn maps to exactly one
 * HTTP status code via `statusForKind`.
 */
export const ApiErrorKind = z.enum([
  "bad_request",
  "unauthorized",
  "reauth_required",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "internal",
  "upstream_unavailable",
  "setup_required",
]);

export type ApiErrorKind = z.infer<typeof ApiErrorKind>;

export const ApiError = z.object({
  error: z.object({
    kind: ApiErrorKind,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiError>;

const STATUS_BY_KIND: Record<ApiErrorKind, number> = {
  bad_request: 400,
  unauthorized: 401,
  reauth_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  upstream_unavailable: 502,
  setup_required: 503,
};

/**
 * Maps an `ApiErrorKind` to the HTTP status code the API responds with for
 * that kind of error.
 */
export function statusForKind(kind: ApiErrorKind): number {
  return STATUS_BY_KIND[kind];
}
