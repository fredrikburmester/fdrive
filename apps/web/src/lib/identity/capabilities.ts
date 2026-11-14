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

/** Every capability set to `value`; for tests that build a login or a provider. */
export const allCapabilities = (value: boolean): ProviderCapabilities =>
  Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, value])) as unknown as ProviderCapabilities;

/**
 * The flags the web reads. Every other flag is always on: the files folder
 * zips, keeps modification times, moves in one step, shares links and
 * folders, and opens in Office.
 */
export type LoginCapabilities = Pick<ProviderCapabilities, "trash" | "index">;

/**
 * Whether deletes go to Trash (the System Trash switch) and whether the
 * files folder is indexed, for search, thumbnails and folder sizes. Before
 * `me` loads, the folder counts as indexed, so thumbnails never flicker, and
 * Trash as off, since "Move to Trash" must wait for the setting.
 */
export function capabilitiesFor(
  me: MeResponse | undefined,
  identityId?: string,
): LoginCapabilities {
  const id = identityId ?? me?.activeIdentityId;
  const identity = me?.identities.find((candidate) => candidate.id === id);
  return {
    trash: identity?.capabilities.trash ?? false,
    index: identity?.capabilities.index ?? true,
  };
}

/**
 * Whether any login linked to the account has `key`: the sidebar shows
 * Trash when at least one login has it, since the login switcher in the
 * sidebar footer works from either page. Before `me` loads, the default
 * applies.
 */
export function anyLoginCan(me: MeResponse | undefined, key: keyof LoginCapabilities): boolean {
  if (me === undefined) return capabilitiesFor(undefined)[key];
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
