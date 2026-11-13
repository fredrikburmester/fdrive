import type { FsEntry, MeResponse, ProviderCapabilities } from "@fdrive/contracts";

export type CapabilityKey = keyof ProviderCapabilities;

/** Every capability flag, so helpers that build a full set cannot miss one. */
const CAPABILITY_FLAGS: Readonly<Record<CapabilityKey, true>> = {
  zip: true,
  setModifiedAt: true,
  atomicMove: true,
  trash: true,
  shares: true,
  shareWithPeople: true,
  office: true,
  index: true,
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITY_FLAGS) as readonly CapabilityKey[];

/** Every capability set to `value`; for tests and for "this provider type can do nothing here". */
export const allCapabilities = (value: boolean): ProviderCapabilities =>
  Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, value])) as unknown as ProviderCapabilities;

/**
 * What the file browser assumes before `/auth/me` has answered: everything
 * a local-folder login can do, except Trash, whose "Move to Trash" label must
 * wait for the login's configuration, and sharing with people, which asks
 * the API about other users and so waits for a login known to have them.
 * This is what the browser showed before capabilities existed, so the
 * common case never flickers.
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  ...allCapabilities(true),
  trash: false,
  shareWithPeople: false,
};

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
 * Shares and Trash when at least one login can use them, since the login
 * switcher in the sidebar footer works from either page. A page reached
 * with a login that lacks the capability states that limit itself
 * (`capabilitiesFor`) rather than asking the API for a refusal. Before
 * `me` loads, the default applies.
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
