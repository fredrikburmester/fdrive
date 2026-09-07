/**
 * Archive extensions `GET /public/shares/:id/archive-entries` can peek, matching the API's
 * own `ArchiveEntriesFormat`: `zip`, `tar`, `tar.gz`, and `tar.zst`. A bare `.gz` and other
 * formats such as `.7z` or `.rar` are excluded, same as the logged-in `archive-entries` route.
 */
const PEEKABLE_ARCHIVE_EXTENSIONS: readonly string[] = [".zip", ".tar.gz", ".tar.zst", ".tar"];

/** True when `name`'s extension (case-insensitive) is one `archive-entries` can peek. */
export function isPeekableArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return PEEKABLE_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface PeekVisibilityOptions {
  /**
   * True when the share carries a download limit. The API always refuses to peek a limited
   * link (every Range read it issues would consume the link's own download budget), so the
   * action is hidden client-side rather than offered and then rejected.
   */
  readonly downloadLimited: boolean;
}

/**
 * Whether a "Peek" action should be shown for `name`, given the share's own limits. Used for
 * both a directory listing's archive rows and a single-file archive share's own download row.
 */
export function canPeekArchive(name: string, options: PeekVisibilityOptions): boolean {
  return !options.downloadLimited && isPeekableArchiveName(name);
}
