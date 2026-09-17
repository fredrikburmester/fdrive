import { isStorageError, StorageError, type StorageProvider } from "@fdrive/core";

/**
 * Publication without a storage lease, the only native write contract for
 * SFTPGo. fdrive serializes Mac desktop writes against each other and rechecks
 * the destination immediately before an atomic server-side rename; any other
 * writer — the web app, Collabora, OCR, or a direct SFTP/FTP/WebDAV client —
 * landing inside that window is silently lost.
 */
export const SFTPGO_OPTIMISTIC_MODE = "verified-optimistic";

/**
 * Stock REST ignores `overwrite: false` on upload, move and copy, so the refusal
 * is emulated with a stat before the mutation. It is only as strong as the
 * fdrive-side lock that serializes the callers: a writer outside that lock can
 * still land between the stat and the mutation, and without the guard the
 * rename silently replaces whatever is there.
 */
export function withOverwriteGuard(storage: StorageProvider): StorageProvider {
  async function absent(path: string) {
    try {
      await storage.stat(path);
    } catch (error) {
      if (isStorageError(error) && error.kind === "not_found") return;
      throw error;
    }
    throw new StorageError("conflict", "The destination already exists");
  }
  return {
    ...storage,
    async upload(path, body, opts) {
      if (opts?.overwrite === false) await absent(path);
      await storage.upload(path, body, opts);
    },
    async move(path, target, opts) {
      if (opts?.overwrite === false) await absent(target);
      await storage.move(path, target, opts);
    },
    async copy(path, target, opts) {
      if (opts?.overwrite === false) await absent(target);
      await storage.copy(path, target, opts);
    },
  };
}
