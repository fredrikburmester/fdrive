/**
 * One dropped or selected file as it moves through the upload queue. `size`
 * and `file` are captured at enqueue time; everything else is mutated only
 * through `uploadReducer` (see `queue.ts`).
 */
export type UploadStatus = "queued" | "uploading" | "done" | "error" | "skipped" | "cancelled";

export interface UploadItem {
  readonly id: string;
  /** Groups one enqueue, so the whole batch reports its outcome once. */
  readonly batchId?: string;
  readonly completedAt?: number;
  /** Captured before conflict handling; retries keep this identity. */
  readonly identityId?: string;
  readonly file: File;
  /** Absolute destination path this file will be written to. */
  readonly targetPath: string;
  /** Path of this file relative to the batch's destination, "/"-separated. */
  readonly relativePath: string;
  readonly size: number;
  readonly status: UploadStatus;
  /** Fraction uploaded, 0..1. Only meaningful while `status` is "uploading" or "done". */
  readonly progress: number;
  readonly error?: string;
  /** Number of times an upload attempt has been started for this item. */
  readonly attempts: number;
}

/** The set of files planned together from a single drop or file picker action. */
export interface UploadBatch {
  readonly id: string;
  /** Absolute path uploads in this batch are relative to. */
  readonly destination: string;
  /** Epoch milliseconds the batch was created. */
  readonly createdAt: number;
}

/**
 * Terminal statuses: an item in one of these states will not transition on
 * its own and is a candidate for `clearFinished`.
 */
export const TERMINAL_STATUSES: ReadonlySet<UploadStatus> = new Set([
  "done",
  "error",
  "skipped",
  "cancelled",
]);

/**
 * Returns a shallow copy of `item` with its `error` field removed entirely
 * (rather than set to `undefined`), which matters under
 * `exactOptionalPropertyTypes`.
 */
export function withoutError(item: UploadItem): UploadItem {
  if (item.error === undefined) {
    return item;
  }
  const next = { ...item };
  delete (next as { error?: string }).error;
  return next;
}
