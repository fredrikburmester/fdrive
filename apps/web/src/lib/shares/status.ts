import type { ManagedShare, PublicShare } from "@fdrive/contracts";

export function shareUnavailable(
  share: Pick<PublicShare, "expiresAt" | "maxDownloads" | "usedDownloads" | "unavailableReason">,
  now = Date.now(),
): string | null {
  if (
    share.unavailableReason === "expired" ||
    (share.expiresAt !== null && Date.parse(share.expiresAt) <= now)
  )
    return "This link has expired.";
  if (
    share.unavailableReason === "limit" ||
    (share.maxDownloads > 0 && share.usedDownloads >= share.maxDownloads)
  )
    return "This link has reached its download limit.";
  return null;
}

export function shareUsage(
  share: Pick<ManagedShare, "scope" | "maxDownloads" | "usedDownloads">,
): string {
  const noun = share.scope === "write" ? "uploads" : "downloads";
  return share.maxDownloads > 0
    ? `${share.usedDownloads} of ${share.maxDownloads} ${noun}`
    : `${share.usedDownloads} ${noun} · No limit`;
}

/**
 * The public share page's own usage line: unlike `shareUsage` (the owner's Shares table, which
 * always shows a count), a link with no limit shows nothing at all rather than an unbounded
 * counter a visitor cannot act on.
 */
export function publicShareUsage(
  share: Pick<PublicShare, "scope" | "maxDownloads" | "usedDownloads">,
): string | null {
  if (share.maxDownloads === 0) return null;
  const noun = share.scope === "write" ? "uploads" : "downloads";
  return `${share.usedDownloads} of ${share.maxDownloads} ${noun}`;
}

/** Friendly Access label for a share's scope, avoiding the internal "read"/"write" vocabulary. */
export function shareAccessLabel(scope: "read" | "write"): string {
  return scope === "read" ? "Can view" : "Can upload";
}

/**
 * Shown-to-owner label for the shared item, without exposing any path beyond the item's own
 * name. A single shared root becomes "Everything"; several selected files or folders collapse
 * to a count rather than listing every name.
 */
export function shareItemLabel(paths: readonly string[]): string {
  if (paths.length > 1) return `${paths.length} items`;
  const path = paths[0];
  if (path === undefined || path === "/") return "Everything";
  return path.slice(path.lastIndexOf("/") + 1);
}
