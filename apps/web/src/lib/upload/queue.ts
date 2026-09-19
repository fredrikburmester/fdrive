import { TERMINAL_STATUSES, type UploadItem, withoutError } from "./types.ts";

/**
 * Normalized queue state: items keyed by id, plus an `order` array that
 * records insertion order so the UI can render a stable list without
 * depending on object key iteration order.
 */
export interface UploadQueueState {
  readonly items: Readonly<Record<string, UploadItem>>;
  readonly order: readonly string[];
}

export const initialUploadQueueState: UploadQueueState = { items: {}, order: [] };

export type UploadAction =
  | { readonly type: "enqueue"; readonly items: readonly UploadItem[] }
  | { readonly type: "start"; readonly id: string }
  | { readonly type: "progress"; readonly id: string; readonly loaded: number }
  | { readonly type: "succeed"; readonly id: string; readonly completedAt?: number }
  | { readonly type: "fail"; readonly id: string; readonly message: string }
  | { readonly type: "skip"; readonly id: string }
  | { readonly type: "cancel"; readonly id: string }
  | { readonly type: "retry"; readonly id: string }
  | { readonly type: "clearFinished" };

function updateItem(
  state: UploadQueueState,
  id: string,
  update: (item: UploadItem) => UploadItem,
): UploadQueueState {
  const existing = state.items[id];
  if (existing === undefined) {
    return state;
  }
  const next = update(existing);
  if (next === existing) {
    return state;
  }
  return { ...state, items: { ...state.items, [id]: next } };
}

function clampProgress(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Pure reducer over `UploadQueueState`. Every transition is a no-op when the
 * referenced item does not exist or is not in a state the action applies
 * to, so dispatchers never need to guard first.
 */
export function uploadReducer(state: UploadQueueState, action: UploadAction): UploadQueueState {
  switch (action.type) {
    case "enqueue": {
      if (action.items.length === 0) {
        return state;
      }
      const items = { ...state.items };
      const order = state.order.slice();
      for (const item of action.items) {
        if (items[item.id] === undefined) {
          order.push(item.id);
        }
        items[item.id] = item;
      }
      return { items, order };
    }

    case "start":
      return updateItem(state, action.id, (item) =>
        item.status === "queued"
          ? { ...withoutError(item), status: "uploading", progress: 0, attempts: item.attempts + 1 }
          : item,
      );

    case "progress":
      return updateItem(state, action.id, (item) => {
        if (item.status !== "uploading") {
          return item;
        }
        const progress = item.size > 0 ? clampProgress(action.loaded / item.size) : 1;
        return { ...item, progress };
      });

    case "succeed":
      return updateItem(state, action.id, (item) => ({
        ...withoutError(item),
        status: "done",
        progress: 1,
        ...(action.completedAt === undefined ? {} : { completedAt: action.completedAt }),
      }));

    case "fail":
      return updateItem(state, action.id, (item) =>
        item.status === "uploading" ? { ...item, status: "error", error: action.message } : item,
      );

    case "skip":
      return updateItem(state, action.id, (item) =>
        item.status === "queued" ? { ...item, status: "skipped" } : item,
      );

    case "cancel":
      return updateItem(state, action.id, (item) =>
        item.status === "queued" || item.status === "uploading"
          ? { ...withoutError(item), status: "cancelled" }
          : item,
      );

    case "retry":
      return updateItem(state, action.id, (item) =>
        item.status === "error" || item.status === "cancelled"
          ? { ...withoutError(item), status: "queued", progress: 0 }
          : item,
      );

    case "clearFinished": {
      // A batch stays whole while any of its files is still running, so its
      // finished entries keep their destination actions until it is done.
      const pendingBatches = new Set(
        Object.values(state.items)
          .filter((item) => !TERMINAL_STATUSES.has(item.status))
          .map((item) => item.batchId)
          .filter((id) => id !== undefined),
      );
      const order = state.order.filter((id) => {
        const item = state.items[id];
        return (
          item !== undefined &&
          (!TERMINAL_STATUSES.has(item.status) ||
            (item.batchId !== undefined && pendingBatches.has(item.batchId)))
        );
      });
      if (order.length === state.order.length) {
        return state;
      }
      const items: Record<string, UploadItem> = {};
      for (const id of order) {
        const item = state.items[id];
        if (item !== undefined) {
          items[id] = item;
        }
      }
      return { items, order };
    }

    /* v8 ignore next 4 -- exhaustiveness guard, unreachable for a well-typed UploadAction */
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * Selects up to `concurrency - inFlight` queued items, in queue order, that
 * should be started next. Pure: callers are responsible for actually
 * starting the uploads and dispatching `start`.
 */
export function nextToStart(state: UploadQueueState, concurrency = 4): UploadItem[] {
  let inFlight = 0;
  for (const id of state.order) {
    if (state.items[id]?.status === "uploading") {
      inFlight++;
    }
  }
  const available = Math.max(0, concurrency - inFlight);
  if (available === 0) {
    return [];
  }

  const result: UploadItem[] = [];
  for (const id of state.order) {
    if (result.length >= available) {
      break;
    }
    const item = state.items[id];
    if (item !== undefined && item.status === "queued") {
      result.push(item);
    }
  }
  return result;
}

/** Aggregate totals over the whole queue, used to drive the panel's overall progress bar. */
export interface UploadSummary {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly inFlight: number;
  readonly bytesTotal: number;
  readonly bytesDone: number;
  /** 0..1, or 1 when there is nothing left to upload. */
  readonly overallProgress: number;
}

const INACTIVE_STATUSES: ReadonlySet<UploadItem["status"]> = new Set(["skipped", "cancelled"]);

/**
 * Summarizes the queue: counts by outcome plus byte totals for an overall
 * progress bar. Skipped and cancelled items are excluded from the byte
 * totals since they were never going to transfer any bytes.
 */
export function summarize(state: UploadQueueState): UploadSummary {
  let total = 0;
  let done = 0;
  let failed = 0;
  let inFlight = 0;
  let bytesTotal = 0;
  let bytesDone = 0;

  for (const id of state.order) {
    const item = state.items[id];
    if (item === undefined) {
      continue;
    }
    total++;
    switch (item.status) {
      case "done":
        done++;
        break;
      case "error":
        failed++;
        break;
      case "uploading":
        inFlight++;
        break;
      default:
        break;
    }
    if (!INACTIVE_STATUSES.has(item.status)) {
      bytesTotal += item.size;
      bytesDone += item.status === "done" ? item.size : item.size * item.progress;
    }
  }

  const overallProgress = bytesTotal > 0 ? bytesDone / bytesTotal : total > 0 ? 1 : 0;

  return { total, done, failed, inFlight, bytesTotal, bytesDone, overallProgress };
}
