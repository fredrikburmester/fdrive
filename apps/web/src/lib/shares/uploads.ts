import { ApiError, ShareId } from "@fdrive/contracts";
import { uploadWithProgress, type XhrLike } from "@/lib/upload/xhr";
import { publicUploadUrl } from "./client";
import { publicUploadPath } from "./paths";

export interface ShareUploadItem {
  readonly id: string;
  readonly file: File;
  readonly status: "queued" | "uploading" | "done" | "error" | "cancelled";
  readonly progress: number;
  readonly error: string | null;
}
export interface ShareUploadDeps {
  readonly createXhr?: () => XhrLike;
  readonly createId?: () => string;
  readonly concurrency?: number;
}

export function validatePublicUploadFiles(files: readonly File[]): void {
  for (const file of files) {
    if (file.webkitRelativePath)
      throw new Error("Choose files individually. Folder uploads are not supported.");
    publicUploadPath(file.name);
  }
}

export function publicUploadError(body: string, status: number): string {
  if (body.length <= 8192) {
    try {
      const error = ApiError.safeParse(JSON.parse(body));
      if (error.success) return error.data.error.message.slice(0, 2048);
    } catch {
      /* A non-JSON upstream response uses a generic message. */
    }
  }
  return status === 401 || status === 403
    ? "Upload denied. Check the share password and try again."
    : "The upload failed. Try again.";
}

/** Separate per-page queue; public uploads never consult account identity or credentials. */
export function createShareUploadQueue(id: string, deps: ShareUploadDeps = {}) {
  ShareId.parse(id);
  let items: readonly ShareUploadItem[] = [];
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  const concurrency = deps.concurrency ?? 4;
  const createXhr = deps.createXhr ?? (() => new XMLHttpRequest());
  const createId = deps.createId ?? (() => crypto.randomUUID());
  function publish(next: readonly ShareUploadItem[]) {
    items = next;
    for (const listener of listeners) listener();
  }
  function patch(itemId: string, values: Partial<ShareUploadItem>) {
    publish(items.map((item) => (item.id === itemId ? { ...item, ...values } : item)));
  }
  function schedule() {
    if (disposed) return;
    const capacity = Math.max(
      0,
      concurrency - items.filter((item) => item.status === "uploading").length,
    );
    for (const item of items.filter((item) => item.status === "queued").slice(0, capacity))
      start(item);
  }
  function start(item: ShareUploadItem) {
    const started = generation;
    const controller = new AbortController();
    controllers.set(item.id, controller);
    patch(item.id, { status: "uploading", progress: 0, error: null });
    const active = () =>
      !disposed &&
      started === generation &&
      controllers.get(item.id) === controller &&
      items.some((current) => current.id === item.id && current.status === "uploading");
    void uploadWithProgress(
      {
        url: publicUploadUrl(id, publicUploadPath(item.file.name)),
        file: item.file,
        headers: { "x-requested-with": "fdrive" },
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (active())
            patch(item.id, {
              progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
            });
        },
      },
      createXhr,
    )
      .then((result) => {
        if (!active()) return;
        if (result.status >= 200 && result.status < 300)
          patch(item.id, { status: "done", progress: 100 });
        else
          patch(item.id, { status: "error", error: publicUploadError(result.body, result.status) });
      })
      .catch((cause: unknown) => {
        if (active())
          patch(item.id, {
            status: controller.signal.aborted ? "cancelled" : "error",
            error:
              cause instanceof Error && cause.name === "AbortError"
                ? null
                : "The upload was interrupted. Try again.",
          });
      })
      .finally(() => {
        if (controllers.get(item.id) === controller) controllers.delete(item.id);
        if (started === generation) schedule();
      });
  }
  return {
    getSnapshot: () => items,
    activate() {
      disposed = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue(files: readonly File[]) {
      if (disposed) return;
      validatePublicUploadFiles(files);
      publish([
        ...items,
        ...files.map(
          (file): ShareUploadItem => ({
            id: createId(),
            file,
            status: "queued",
            progress: 0,
            error: null,
          }),
        ),
      ]);
      schedule();
    },
    cancel(itemId: string) {
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item || (item.status !== "queued" && item.status !== "uploading")) return;
      controllers.get(itemId)?.abort();
      patch(itemId, { status: "cancelled", error: null });
      schedule();
    },
    retry(itemId: string) {
      const item = items.find((item) => item.id === itemId);
      if (!item || (item.status !== "error" && item.status !== "cancelled") || disposed) return;
      patch(itemId, { status: "queued", progress: 0, error: null });
      schedule();
    },
    credentialsChanged() {
      generation++;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      publish(
        items.map((item) =>
          item.status === "queued" || item.status === "uploading"
            ? { ...item, status: "cancelled", error: null }
            : item,
        ),
      );
    },
    dispose() {
      disposed = true;
      generation++;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      publish([]);
      listeners.clear();
    },
  };
}
