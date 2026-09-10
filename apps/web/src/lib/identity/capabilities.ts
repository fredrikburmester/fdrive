import type { FsEntry, MeResponse, ProviderCapabilities } from "@fdrive/contracts";
import type { RowContextAction } from "@/components/files/file-context-menu";
import type { FilesActionType } from "@/lib/files/keyboard";
import type { ToolbarActionId } from "@/lib/files/toolbar-visibility";

export type CapabilityKey = keyof ProviderCapabilities;

/**
 * What the file browser assumes before `/auth/me` has answered: everything
 * an SFTPGo login can do, except Trash, whose "Move to Trash" label must
 * wait for the login's configuration. This is exactly what the browser
 * showed before capabilities existed, so the common case never flickers.
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  zip: true,
  setModifiedAt: true,
  atomicMove: true,
  trash: false,
  shares: true,
  office: true,
  index: true,
  scopeMapping: true,
};

/** Every capability set to `value`; for tests and for "this provider type can do nothing here". */
export function allCapabilities(value: boolean): ProviderCapabilities {
  return {
    zip: value,
    setModifiedAt: value,
    atomicMove: value,
    trash: value,
    shares: value,
    office: value,
    index: value,
    scopeMapping: value,
  };
}

/** Short user-facing names, for the capability chips on System > Storage. */
export const CAPABILITY_LABELS: Readonly<Record<CapabilityKey, string>> = {
  zip: "Zip download",
  setModifiedAt: "Keeps modification times",
  atomicMove: "Atomic move",
  trash: "Trash",
  shares: "Shares",
  office: "Office",
  index: "Search and thumbnails",
  scopeMapping: "Virtual folders",
};

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  "zip",
  "setModifiedAt",
  "atomicMove",
  "trash",
  "shares",
  "office",
  "index",
  "scopeMapping",
];

/**
 * The capabilities of one linked login (`identityId`, defaulting to the
 * active one). Falls back to `DEFAULT_CAPABILITIES` while `me` is still
 * loading or when the login is unknown.
 */
export function capabilitiesFor(
  me: MeResponse | undefined,
  identityId?: string,
): ProviderCapabilities {
  const id = identityId ?? me?.activeIdentityId;
  const identity = me?.identities.find((candidate) => candidate.id === id);
  return identity?.capabilities ?? DEFAULT_CAPABILITIES;
}

/**
 * Whether any login linked to the account has `key`: the sidebar shows
 * Shares and Trash when at least one login can use them, since either page
 * can switch logins on its own. Before `me` loads, the default applies.
 */
export function anyLoginCan(me: MeResponse | undefined, key: CapabilityKey): boolean {
  if (me === undefined) return DEFAULT_CAPABILITIES[key];
  return me.identities.some((identity) => identity.capabilities[key]);
}

/** How many files and folders an action would apply to. */
export interface BrowserSelection {
  readonly files: number;
  readonly folders: number;
}

export const NO_SELECTION: BrowserSelection = { files: 0, folders: 0 };

export function selectionOf(entries: readonly Pick<FsEntry, "kind">[]): BrowserSelection {
  let files = 0;
  let folders = 0;
  for (const entry of entries) {
    if (entry.kind === "dir") folders += 1;
    else files += 1;
  }
  return { files, folders };
}

/** Every action id the browser's context menu, toolbar and keyboard map can dispatch. */
export type BrowserActionId = RowContextAction | ToolbarActionId | FilesActionType;

const ALWAYS_AVAILABLE: readonly BrowserActionId[] = [
  "open",
  "revealInFolder",
  "rename",
  "moveTo",
  "copyTo",
  "delete",
  "duplicate",
  "compress",
  "extractHere",
  "extractTo",
  "view",
  "upload",
  "details",
  "clearSelection",
  "move",
  "setView",
  "quickLook",
  "selectAll",
  "clear",
  "newFolder",
  "goToParent",
  "expand",
  "collapse",
];

/**
 * True when downloading `selection` needs the server to build a zip: more
 * than one entry, or any folder. A provider without `zip` can still hand
 * out each file on its own, so a mixed selection stays downloadable there
 * as long as it holds at least one file; the folders are skipped.
 */
export function downloadNeedsZip(selection: BrowserSelection): boolean {
  return selection.folders > 0 || selection.files !== 1;
}

export function canDownload(
  capabilities: Pick<ProviderCapabilities, "zip">,
  selection: BrowserSelection,
): boolean {
  if (capabilities.zip) return selection.files + selection.folders > 0;
  return selection.files > 0;
}

/**
 * Which of the browser's action ids are available for a login with
 * `capabilities` acting on `selection`. Ids missing from the set are hidden
 * from the context menu and toolbar and ignored by the keyboard map; the
 * API refuses them too, so this is presentation, not enforcement.
 *
 * Only three groups depend on a capability: Share (`shares`), the Office
 * items (`office`), and Download (`zip`, see `canDownload`). Everything else
 * is always available; virtual listings add their own hiding on top.
 */
export function browserActions(
  capabilities: ProviderCapabilities,
  selection: BrowserSelection,
): ReadonlySet<BrowserActionId> {
  const available = new Set<BrowserActionId>(ALWAYS_AVAILABLE);
  if (capabilities.shares) available.add("share");
  if (capabilities.office) {
    available.add("office:view");
    available.add("office:edit");
    available.add("office:convert");
  }
  if (canDownload(capabilities, selection)) available.add("download");
  return available;
}
