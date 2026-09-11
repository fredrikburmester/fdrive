import type { AnchorDownloader, DownloadDeps } from "./download";

/** The API client members a download needs, injected so each caller keeps its own client. */
export type DownloadApiClient = Pick<DownloadDeps, "downloadUrl" | "zip">;

/**
 * Builds a fresh `DownloadDeps` bound to the current `document`. Only ever
 * called from an event handler, never at render time, so it never runs
 * during server-side rendering.
 *
 * `client` is a parameter rather than a module import so a caller keeps the
 * client its own feature resolves (and its tests mock), instead of this
 * module reaching past them for a second one.
 */
export function buildDownloadDeps(
  anchor: AnchorDownloader,
  client: DownloadApiClient,
): DownloadDeps {
  return {
    downloadUrl: (downloadPath, opts) => client.downloadUrl(downloadPath, opts),
    zip: (paths, name) => client.zip(paths, name),
    anchor,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}
