import { isStorageError, StorageError, type StorageErrorKind } from "@fdrive/core";

const MAX_DETAIL_LENGTH = 500;

/** Error codes whose meaning is fixed across S3 implementations. */
const CODE_KINDS: Readonly<Record<string, StorageErrorKind>> = {
  NoSuchKey: "not_found",
  NotFound: "not_found",
  NoSuchUpload: "not_found",
  AccessDenied: "forbidden",
  AllAccessDisabled: "forbidden",
  InvalidAccessKeyId: "unauthorized",
  SignatureDoesNotMatch: "unauthorized",
  ExpiredToken: "unauthorized",
  InvalidToken: "unauthorized",
  PreconditionFailed: "conflict",
  BucketNotEmpty: "conflict",
  EntityTooLarge: "payload_too_large",
  SlowDown: "rate_limited",
  TooManyRequests: "rate_limited",
  ServiceUnavailable: "rate_limited",
  InvalidRequest: "bad_request",
  InvalidArgument: "bad_request",
  InvalidRange: "bad_request",
  MalformedXML: "bad_request",
  KeyTooLongError: "bad_request",
  NoSuchBucket: "upstream_unavailable",
  PermanentRedirect: "upstream_unavailable",
  InternalError: "upstream_unavailable",
};

/** Codes whose server message may echo the string-to-sign, which names the access key. */
const REDACTED_CODES = new Set(["SignatureDoesNotMatch", "InvalidAccessKeyId"]);

function kindForStatus(status: number): StorageErrorKind {
  switch (status) {
    case 400:
    case 416:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
    case 412:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      if (status >= 300 && status < 400) return "upstream_unavailable";
      if (status >= 500 && status < 600) return "upstream_unavailable";
      return "internal";
  }
}

interface SdkErrorShape {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
}

/** The S3 error code (`name`) and HTTP status the SDK attached to a rejection, when any. */
export function describeSdkError(error: unknown): {
  code: string | null;
  status: number | null;
  message: string;
} {
  if (typeof error !== "object" || error === null) {
    return { code: null, status: null, message: String(error) };
  }
  const shape = error as SdkErrorShape;
  const code = typeof shape.name === "string" && shape.name.length > 0 ? shape.name : null;
  const rawStatus = shape.$metadata?.httpStatusCode;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const message = typeof shape.message === "string" ? shape.message : String(error);
  return { code, status, message };
}

/** The `StorageErrorKind` for an SDK rejection: by code first, then by status, else `internal`. */
export function kindForSdkError(error: unknown): StorageErrorKind {
  const { code, status } = describeSdkError(error);
  if (code !== null && CODE_KINDS[code] !== undefined) return CODE_KINDS[code] as StorageErrorKind;
  if (code === "AbortError" || code === "TimeoutError") return "upstream_unavailable";
  if (status !== null) return kindForStatus(status);
  // A rejected fetch (`TypeError: fetch failed`) has no code and no status.
  return code === null || code === "TypeError" || code === "Error"
    ? "upstream_unavailable"
    : "internal";
}

/**
 * Converts an SDK rejection into a `StorageError`, keeping the S3 code and
 * status in `details` and a bounded, credential-free detail. Signature
 * failures carry no server message: MinIO echoes the string-to-sign, which
 * includes the access key ID. A `StorageError` passes through unchanged.
 */
export function toStorageError(error: unknown, path?: string): StorageError {
  if (isStorageError(error)) return error;
  const { code, status, message } = describeSdkError(error);
  const kind = kindForSdkError(error);
  const details: Record<string, unknown> = {};
  if (code !== null) details.code = code;
  if (status !== null) details.status = status;
  if (path !== undefined) details.path = path;
  const detail =
    code !== null && REDACTED_CODES.has(code)
      ? "the access key or secret was refused"
      : message.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_LENGTH);
  if (detail.length > 0) details.detail = detail;
  const summary = code ?? (status === null ? "request failed" : `status ${status}`);
  return new StorageError(kind, `S3 request failed: ${summary}`, {
    cause: error,
    details,
  });
}
