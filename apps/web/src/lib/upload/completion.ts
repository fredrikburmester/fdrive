import { TERMINAL_STATUSES, type UploadItem } from "./types";

export interface UploadCompletion {
  readonly batchId: string;
  readonly items: readonly UploadItem[];
  readonly message: string;
  readonly hasFailures: boolean;
}

/** One truthful batch result, including skipped/cancelled entries. */
export function uploadCompletions(items: readonly UploadItem[]): UploadCompletion[] {
  const batches = new Map<string, UploadItem[]>();
  for (const item of items) {
    if (item.batchId === undefined) continue;
    const group = batches.get(item.batchId) ?? [];
    group.push(item);
    batches.set(item.batchId, group);
  }
  return [...batches].flatMap(([batchId, group]) => {
    if (group.some((item) => !TERMINAL_STATUSES.has(item.status))) return [];
    const labels = {
      done: "uploaded",
      error: "failed",
      skipped: "skipped",
      cancelled: "cancelled",
    } as const;
    const message = Object.entries(labels)
      .flatMap(([status, label]) => {
        const count = group.filter((item) => item.status === status).length;
        return count ? [`${count} ${label}`] : [];
      })
      .join(" · ");
    return [
      {
        batchId,
        items: group,
        message,
        hasFailures: group.some((item) => item.status === "error"),
      },
    ];
  });
}
