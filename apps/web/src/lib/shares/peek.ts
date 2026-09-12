import { isPeekableArchiveName } from "@fdrive/core";

export { isPeekableArchiveName } from "@fdrive/core";

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
