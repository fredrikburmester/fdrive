import { isStorageError } from "@fdrive/core";
export class WopiError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super("Office operation failed");
  }
}
export function officeErrorResponse(error: unknown): Response {
  if (error instanceof WopiError)
    return new Response(null, { status: error.status, headers: error.headers });
  if (isStorageError(error)) {
    const status = {
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      bad_request: 400,
      rate_limited: 429,
      upstream_unavailable: 502,
      internal: 500,
    }[error.kind];
    return new Response(null, { status, headers: status === 409 ? { "X-WOPI-Lock": "" } : {} });
  }
  return new Response(null, { status: 500 });
}
export function requireMatchingLock(
  current: string | null,
  provided: string | undefined,
  emptyAllowed = true,
): void {
  if ((current !== null && current !== provided) || (current === null && !emptyAllowed))
    throw new WopiError(409, { "X-WOPI-Lock": current ?? "" });
}
