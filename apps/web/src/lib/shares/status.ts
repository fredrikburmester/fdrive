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
