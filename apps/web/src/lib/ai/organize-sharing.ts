import { DEFAULT_ORGANIZE_SHARING, OrganizeSharing } from "@fdrive/contracts";

/** Where this browser remembers what its person last chose to share with the assistant. */
export const ORGANIZE_SHARING_KEY = "fdrive.organize.share";

function storageOf(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The sharing choice this browser remembers, or everything when it has none or it does not parse. */
export function loadOrganizeSharing(): OrganizeSharing {
  const raw = storageOf()?.getItem(ORGANIZE_SHARING_KEY);
  if (raw === null || raw === undefined) return DEFAULT_ORGANIZE_SHARING;
  try {
    const parsed = OrganizeSharing.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_ORGANIZE_SHARING;
  } catch {
    return DEFAULT_ORGANIZE_SHARING;
  }
}

/** Remembers `share` for the next Organize session in this browser. */
export function saveOrganizeSharing(share: OrganizeSharing): void {
  try {
    storageOf()?.setItem(ORGANIZE_SHARING_KEY, JSON.stringify(share));
  } catch {
    // A full or blocked storage only loses the memory of the choice, not the choice itself.
  }
}
