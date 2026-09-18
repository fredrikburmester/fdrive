/** The three numbers that decide whether a share still admits a request, whatever stores it. */
export interface ShareLimits {
  readonly expiresAt: Date | null;
  /** 0 is unlimited. */
  readonly maxDownloads: number;
  readonly usedDownloads: number;
}

export function unavailableReason(share: ShareLimits, now: Date): "expired" | "limit" | null {
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) return "expired";
  if (share.maxDownloads > 0 && share.usedDownloads >= share.maxDownloads) return "limit";
  return null;
}

/**
 * Everything the public share thumb route needs to decide whether a
 * thumbnail may be served, without reaching into `ShareRepo` or the storage
 * behind the share: see `SharesService.publicThumbTarget`.
 */
export interface PublicThumbTarget {
  readonly identityId: string;
  readonly scope: "read" | "write";
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly unavailableReason: ReturnType<typeof unavailableReason>;
}
