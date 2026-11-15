import { ApiError, buildRequestUrl, MODIFIED_AT_HEADER, ROUTES } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createDefaultOnUploaded } from "./deps.ts";
import {
  initialUploadQueueState,
  nextToStart,
  type UploadAction,
  type UploadQueueState,
  uploadReducer,
} from "./queue.ts";
import type { UploadItem } from "./types.ts";
import { type UploadWithProgressResult, uploadWithProgress, type XhrLike } from "./xhr.ts";

/** Dependencies the upload store's side effects run against. Every field has a usable default. */
export interface UploadStoreDeps {
  /** Prefixed to every upload request URL. Defaults to "" (same-origin). */
  readonly baseUrl?: string;
  /** Max number of uploads in flight at once. Defaults to 4. */
  readonly concurrency?: number;
  /** Defaults to `() => new XMLHttpRequest()`. Override in tests with a fake. */
  readonly createXhr?: () => XhrLike;
  /** Called with the parent directory of every successfully uploaded file. */
  readonly onUploaded?: (parentPath: string) => void;
  /** Defaults to `CHUNK_BYTES`. */
  readonly chunkBytes?: number;
  /** Defaults to 1, 2, 4 and 8 seconds. */
  readonly retryDelaysMs?: readonly number[];
}

export interface UploadStoreState {
  readonly state: UploadQueueState;
  reset(): void;
  enqueue(items: readonly UploadItem[]): void;
  retry(id: string): void;
  cancel(id: string): void;
  clearFinished(): void;
  /** Lets the shell replace the `onUploaded` callback after construction. */
  setOnUploaded(onUploaded: (parentPath: string) => void): void;
}

export type UploadStore = UseBoundStore<StoreApi<UploadStoreState>>;

/**
 * Parses an upload response body as an `ApiError` and returns its message,
 * falling back to a generic message including the status when the body is
 * empty or not a well-formed `ApiError`.
 */
export function parseUploadErrorMessage(body: string, status: number): string {
  if (body.length > 0) {
    try {
      const parsed = ApiError.safeParse(JSON.parse(body));
      if (parsed.success) {
        return parsed.data.error.message;
      }
    } catch {
      // Not JSON, or not JSON matching ApiError: fall through.
    }
  }
  return `upload failed with status ${status}`;
}

/** Message for a rejected `uploadWithProgress` promise that was not an abort. */
export function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "network request failed";
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Bytes per request: a file up to this size takes one request, a bigger one several, in order. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/** Waits before each retry of a piece that failed on the way; then the file fails. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/** Where a file's upload stands: its part on the server and the bytes the server has. */
interface Part {
  readonly id: string;
  offset: number;
}

function newPart(): Part {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return { id: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), offset: 0 };
}

function buildUploadUrl(baseUrl: string, targetPath: string, part: Part, final: boolean): string {
  return buildRequestUrl(baseUrl, ROUTES.fs.upload, {
    path: targetPath,
    mkdirParents: "true",
    part: part.id,
    offset: String(part.offset),
    final: final ? "true" : undefined,
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

function buildUploadHeaders(item: UploadItem): Record<string, string> {
  const headers: Record<string, string> = {
    "x-requested-with": "fdrive",
    [MODIFIED_AT_HEADER]: String(item.file.lastModified),
  };
  // One ID per attempt: a request delivered twice records one upload, while a
  // retry the person asked for is a new one.
  headers["x-fdrive-operation-id"] = `${item.id}:${item.attempts + 1}`;
  if (item.batchId) headers["x-fdrive-batch-id"] = item.batchId;
  return headers;
}

/**
 * Builds a zustand store that owns the upload queue's state and its side
 * effects: starting up to `concurrency` uploads at a time via
 * `uploadWithProgress`, mapping responses to `succeed`/`fail`, and calling
 * `onUploaded` for the parent of every file that finishes successfully.
 * Every side effect is driven through the `deps` parameter so the store can
 * be exercised in tests with fakes and no real network or DOM.
 */
export function createUploadStore(deps: UploadStoreDeps = {}): UploadStore {
  const baseUrl = deps.baseUrl ?? "";
  const concurrency = deps.concurrency ?? 4;
  const createXhr = deps.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike);
  const chunkBytes = deps.chunkBytes ?? CHUNK_BYTES;
  const retryDelaysMs = deps.retryDelaysMs ?? RETRY_DELAYS_MS;

  let onUploaded = deps.onUploaded ?? (() => {});
  const controllers = new Map<string, AbortController>();
  // Kept after a lost connection, so retrying the file resumes where it stopped.
  const parts = new Map<string, Part>();

  return create<UploadStoreState>((set, get) => {
    function dispatch(action: UploadAction): void {
      set((s) => ({ state: uploadReducer(s.state, action) }));
    }

    function scheduleNext(): void {
      const toStart = nextToStart(get().state, concurrency);
      for (const item of toStart) {
        startUpload(item);
      }
    }

    /** Sends the piece of `item` from `part.offset` to `end`, again while retries last. */
    async function sendPiece(
      item: UploadItem,
      part: Part,
      end: number,
      signal: AbortSignal,
    ): Promise<UploadWithProgressResult> {
      for (let attempt = 0; ; attempt += 1) {
        const delay = retryDelaysMs[attempt];
        try {
          const result = await uploadWithProgress(
            {
              url: buildUploadUrl(baseUrl, item.targetPath, part, end === item.size),
              file: item.file.slice(part.offset, end),
              headers: buildUploadHeaders(item),
              onProgress: (loaded) =>
                dispatch({ type: "progress", id: item.id, loaded: part.offset + loaded }),
              signal,
            },
            createXhr,
          );
          // Only a server fault may pass on its own; any other answer is final.
          if (result.status < 500 || delay === undefined) return result;
        } catch (err) {
          if (isAbortError(err) || delay === undefined) throw err;
        }
        await wait(delay, signal);
      }
    }

    /** Sends `item` piece by piece from where `part` stands, stopping at the first failure. */
    async function sendFile(
      item: UploadItem,
      part: Part,
      signal: AbortSignal,
    ): Promise<UploadWithProgressResult> {
      for (;;) {
        const end = Math.min(part.offset + chunkBytes, item.size);
        const result = await sendPiece(item, part, end, signal);
        if (end === item.size || result.status < 200 || result.status >= 300) return result;
        part.offset = end;
      }
    }

    function startUpload(item: UploadItem): void {
      dispatch({ type: "start", id: item.id });

      const controller = new AbortController();
      controllers.set(item.id, controller);
      const part = parts.get(item.id) ?? newPart();
      parts.set(item.id, part);
      dispatch({ type: "progress", id: item.id, loaded: part.offset });

      sendFile(item, part, controller.signal)
        .then((result) => {
          controllers.delete(item.id);
          // Done, or refused: a refusal would not pass on a retry, which starts afresh.
          if (result.status < 500) parts.delete(item.id);
          if (result.status >= 200 && result.status < 300) {
            dispatch({ type: "succeed", id: item.id, completedAt: Date.now() });
            onUploaded(parentPath(item.targetPath));
          } else {
            dispatch({
              type: "fail",
              id: item.id,
              message: parseUploadErrorMessage(result.body, result.status),
            });
          }
          scheduleNext();
        })
        .catch((err: unknown) => {
          controllers.delete(item.id);
          if (isAbortError(err)) {
            dispatch({ type: "cancel", id: item.id });
          } else {
            dispatch({ type: "fail", id: item.id, message: networkErrorMessage(err) });
          }
          scheduleNext();
        });
    }

    return {
      state: initialUploadQueueState,
      reset() {
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        parts.clear();
        set({ state: initialUploadQueueState });
      },

      enqueue(items) {
        const batchId = crypto.randomUUID();
        const captured = items.map((item) => ({ ...item, batchId: item.batchId ?? batchId }));
        dispatch({ type: "enqueue", items: captured });
        scheduleNext();
      },

      retry(id) {
        dispatch({ type: "retry", id });
        scheduleNext();
      },

      cancel(id) {
        const controller = controllers.get(id);
        if (controller !== undefined) {
          controller.abort();
        } else {
          dispatch({ type: "cancel", id });
        }
      },

      clearFinished() {
        dispatch({ type: "clearFinished" });
      },

      setOnUploaded(next) {
        onUploaded = next;
      },
    };
  });
}

/**
 * The app-wide upload queue singleton. Components under
 * `src/components/upload` use this; the shell can call
 * `useUploadStore.getState().setOnUploaded(...)` once it has a query client
 * to invalidate against.
 */
export const useUploadStore: UploadStore = createUploadStore({
  onUploaded: createDefaultOnUploaded(),
});
