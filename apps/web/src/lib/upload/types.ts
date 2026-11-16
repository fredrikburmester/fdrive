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
  /**
   * Makes the bytes to send in place of `file`, once per item and kept for a
   * resume: an encrypted folder's ciphertext, or a file fdrive moves across
   * an encrypted folder's edge. `size` is then only shown, not sent.
   */
  readonly source?: () => Promise<Blob>;
  /** Runs once the file is stored, before the item counts as done: removing what was moved. */
  readonly after?: () => Promise<void>;
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
