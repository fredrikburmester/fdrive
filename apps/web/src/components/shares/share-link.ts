import type { ManagedShare } from "@fdrive/contracts";
import { isAtOrUnder, TRASH_PATH } from "@fdrive/core";
import type { StatusTone } from "@/components/shell/status";
import { activityGesture } from "@/lib/activity/gestures";
import { publicShareHref } from "@/lib/shares/paths";

/** A link's public address: absolute in the browser, the bare path while rendering on the server. */
export function shareLinkUrl(id: string): string {
  const href = publicShareHref(id);
  return typeof window === "undefined" ? href : new URL(href, window.location.origin).href;
}

/**
 * Copies a link's public address and records the copy in the owner's activity. Rejects when the
 * browser refuses the clipboard, and records nothing then.
 */
export async function copyShareLink(share: Pick<ManagedShare, "id" | "paths">): Promise<void> {
  const report = activityGesture("share.copy_link", share.paths[0] ?? "/", share.id);
  await navigator.clipboard.writeText(shareLinkUrl(share.id));
  void report().catch(() => undefined);
}

/**
 * True when a shared path lies in Trash. A link follows what it shares there, where nobody can
 * reach it, and works again once that is restored.
 */
export function sharedPathInTrash(path: string): boolean {
  return isAtOrUnder(TRASH_PATH, path);
}

/** True once a link's expiry has passed. */
export function shareExpired(share: Pick<ManagedShare, "expiresAt">, now = Date.now()): boolean {
  return share.expiresAt !== null && Date.parse(share.expiresAt) <= now;
}

export interface ShareState {
  readonly tone: StatusTone;
  readonly label: "Active" | "In Trash" | "Expired" | "Limit reached";
}

/** Whether a link still works, as the word and tone of its `StatusBadge`. */
export function shareState(
  share: Pick<ManagedShare, "paths" | "expiresAt" | "maxDownloads" | "usedDownloads">,
  now = Date.now(),
): ShareState {
  if (share.paths.some(sharedPathInTrash)) {
    return { tone: "warning", label: "In Trash" };
  }
  if (shareExpired(share, now)) {
    return { tone: "warning", label: "Expired" };
  }
  if (share.maxDownloads > 0 && share.usedDownloads >= share.maxDownloads) {
    return { tone: "warning", label: "Limit reached" };
  }
  return { tone: "success", label: "Active" };
}
