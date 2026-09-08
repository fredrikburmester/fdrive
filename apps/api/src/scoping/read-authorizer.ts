import { isStorageError, type StorageErrorKind, type StorageProvider } from "@fdrive/core";

/** Bounds how many probes `createReadAuthorizer` runs concurrently by default. */
export const DEFAULT_READ_AUTHORIZE_CONCURRENCY = 6;

export type ReadAuthorizeReason = "denied" | "missing" | "unavailable";

export type ReadAuthorizeResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ReadAuthorizeReason };

export interface ReadAuthorizeTarget {
  /** The identity's virtual path, as its bound `StorageProvider` sees it; never a physical index path. */
  readonly path: string;
  readonly kind: "file" | "dir";
}

/** A per-request live-read authorizer; see `createReadAuthorizer`. */
export interface ReadAuthorizer {
  authorize(target: ReadAuthorizeTarget): Promise<ReadAuthorizeResult>;
}

export interface CreateReadAuthorizerDeps {
  readonly storage: Pick<StorageProvider, "list" | "download" | "probeDirectoryRead">;
  /** Maximum number of probes in flight at once. Defaults to `DEFAULT_READ_AUTHORIZE_CONCURRENCY`. */
  readonly concurrency?: number;
}

function reasonForStorageErrorKind(kind: StorageErrorKind): ReadAuthorizeReason {
  switch (kind) {
    case "not_found":
      return "missing";
    case "forbidden":
    case "unauthorized":
      return "denied";
    default:
      return "unavailable";
  }
}

/** A minimal counting semaphore bounding how many callers hold it at once. */
function createSemaphore(limit: number): { acquire: () => Promise<void>; release: () => void } {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      const next = queue.shift();
      if (next !== undefined) {
        next();
      }
    },
  };
}

/**
 * Builds a bounded, per-request live-read authorizer. For a file it opens
 * `storage.download` and immediately cancels the body without reading any
 * of it, proving read permission without ever buffering content; for a
 * directory it calls `storage.probeDirectoryRead` (or falls back to
 * `storage.list` when omitted). This never calls `storage.statFile`:
 * a successful stat is not proof of read permission.
 *
 * Duplicate targets (same `kind` and `path`) requested through the same
 * authorizer instance share one probe and its result for the lifetime of
 * that instance; build a fresh authorizer per request so this can never
 * become a global positive path-grant cache. At most `concurrency` probes
 * run at once; the rest queue.
 */
export function createReadAuthorizer(deps: CreateReadAuthorizerDeps): ReadAuthorizer {
  const semaphore = createSemaphore(deps.concurrency ?? DEFAULT_READ_AUTHORIZE_CONCURRENCY);
  const results = new Map<string, Promise<ReadAuthorizeResult>>();

  async function probe(target: ReadAuthorizeTarget): Promise<ReadAuthorizeResult> {
    await semaphore.acquire();
    try {
      if (target.kind === "dir") {
        if (typeof deps.storage.probeDirectoryRead === "function") {
          await deps.storage.probeDirectoryRead(target.path);
        } else {
          await deps.storage.list(target.path);
        }
        return { allowed: true };
      }
      const download = await deps.storage.download(target.path);
      await download.body.cancel();
      return { allowed: true };
    } catch (error) {
      if (isStorageError(error)) {
        return { allowed: false, reason: reasonForStorageErrorKind(error.kind) };
      }
      return { allowed: false, reason: "unavailable" };
    } finally {
      semaphore.release();
    }
  }

  return {
    authorize(target) {
      const key = `${target.kind}:${target.path}`;
      const existing = results.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const promise = probe(target);
      results.set(key, promise);
      return promise;
    },
  };
}
