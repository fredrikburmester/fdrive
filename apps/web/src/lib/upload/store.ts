import {
  ApiError,
  buildRequestUrl,
  IDENTITY_HEADER,
  MODIFIED_AT_HEADER,
  ROUTES,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createDefaultOnUploaded } from "./deps.js";
import {
  initialUploadQueueState,
  nextToStart,
  type UploadAction,
  type UploadQueueState,
  uploadReducer,
} from "./queue.js";
import type { UploadItem } from "./types.js";
import { uploadWithProgress, type XhrLike } from "./xhr.js";

/** Dependencies the upload store's side effects run against. Every field has a usable default. */
export interface UploadStoreDeps {
  /** Prefixed to every upload request URL. Defaults to "" (same-origin). */
  readonly baseUrl?: string;
  /** Max number of uploads in flight at once. Defaults to 4. */
  readonly concurrency?: number;
  /** Sent as the `x-identity-id` header on every upload request, when set. */
  readonly identityId?: string;
  /** Defaults to `() => new XMLHttpRequest()`. Override in tests with a fake. */
  readonly createXhr?: () => XhrLike;
  /** Called with the parent directory of every successfully uploaded file. */
  readonly onUploaded?: (parentPath: string) => void;
}

export interface UploadStoreState {
  readonly state: UploadQueueState;
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

function buildUploadUrl(baseUrl: string, targetPath: string): string {
  return buildRequestUrl(baseUrl, ROUTES.fs.upload, { path: targetPath, mkdirParents: "true" });
}

function buildUploadHeaders(
  item: UploadItem,
  identityId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-requested-with": "fdrive",
    [MODIFIED_AT_HEADER]: String(item.file.lastModified),
  };
  if (identityId !== undefined) {
    headers[IDENTITY_HEADER] = identityId;
  }
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
  const identityId = deps.identityId;
  const createXhr = deps.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike);

  let onUploaded = deps.onUploaded ?? (() => {});
  const controllers = new Map<string, AbortController>();

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

    function startUpload(item: UploadItem): void {
      dispatch({ type: "start", id: item.id });

      const controller = new AbortController();
      controllers.set(item.id, controller);

      uploadWithProgress(
        {
          url: buildUploadUrl(baseUrl, item.targetPath),
          file: item.file,
          headers: buildUploadHeaders(item, identityId),
          onProgress: (loaded) => dispatch({ type: "progress", id: item.id, loaded }),
          signal: controller.signal,
        },
        createXhr,
      )
        .then((result) => {
          controllers.delete(item.id);
          if (result.status >= 200 && result.status < 300) {
            dispatch({ type: "succeed", id: item.id });
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

      enqueue(items) {
        dispatch({ type: "enqueue", items });
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
