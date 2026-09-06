import { ApiClientError, type ApiErrorKind } from "@fdrive/contracts";

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

const MESSAGE_BY_KIND: Record<ApiErrorKind, string> = {
  bad_request: "That request wasn't valid.",
  unauthorized: "You're signed out. Sign in to continue.",
  reauth_required: "Your session needs to be renewed. Sign in again to continue.",
  forbidden: "You don't have permission to do that.",
  not_found: "That item could not be found.",
  conflict: "That change conflicts with the current state. Refresh and try again.",
  payload_too_large: "That file is too large.",
  rate_limited: "Too many requests. Try again in a moment.",
  internal: "Something went wrong on the server. Please try again.",
  upstream_unavailable: "fdrive can't reach the server. Check your connection and try again.",
  setup_required: "fdrive has not been set up yet.",
};

/**
 * Turns any error thrown by the API client into a short, user-facing
 * message suitable for a toast. Known `ApiClientError` kinds get a fixed,
 * friendly message; other errors fall back to their own message (when
 * non-empty) and finally to a generic message.
 */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiClientError) {
    return MESSAGE_BY_KIND[err.kind];
  }
  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return FALLBACK_MESSAGE;
}

/**
 * True when `err` means the caller's session is gone (`unauthorized`) or
 * needs to be renewed (`reauth_required`), the two kinds that should send
 * the user back to `/login`.
 */
export function isReauthRequired(err: unknown): boolean {
  return (
    err instanceof ApiClientError && (err.kind === "unauthorized" || err.kind === "reauth_required")
  );
}
