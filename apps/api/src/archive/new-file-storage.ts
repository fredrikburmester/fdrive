import { isStorageError, normalizePath, StorageError, type StorageProvider } from "@fdrive/core";
import { throwIfAborted } from "./stream-utils.ts";

const pending = new Map<string, Promise<void>>();

/** Serialize archive writes to the same identity/path, including providers without atomic create. */
export function protectArchiveWrites(
  storage: StorageProvider,
  identityId: string,
): StorageProvider {
  return {
    ...storage,
    async upload(rawPath, body, options) {
      const path = normalizePath(rawPath);
      const key = JSON.stringify([identityId, path]);
      const previous = pending.get(key) ?? Promise.resolve();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => done);
      pending.set(key, queued);
      await previous;
      try {
        if (options?.signal !== undefined) throwIfAborted(options.signal);
        try {
          await storage.stat(path);
        } catch (error) {
          if (!isStorageError(error) || error.kind !== "not_found") throw error;
          await storage.upload(path, body, { ...options, overwrite: false });
          return;
        }
        throw new StorageError("conflict", `already exists: ${path}`);
      } catch (error) {
        if (body instanceof ReadableStream && !body.locked)
          await body.cancel().catch(() => undefined);
        throw error;
      } finally {
        release();
        if (pending.get(key) === queued) pending.delete(key);
      }
    },
  };
}
