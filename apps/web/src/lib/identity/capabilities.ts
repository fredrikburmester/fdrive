import type { FsEntry, MeResponse, ProviderCapabilities } from "@fdrive/contracts";

export type CapabilityKey = keyof ProviderCapabilities;

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

export const CAPABILITY_KEYS = Object.keys(CAPABILITY_LABELS) as readonly CapabilityKey[];

/**
 * The features fdrive builds on SFTPGo storage. fdrive is an SFTPGo client
 * first: other storage gets ordinary file management plus whatever fdrive
 * can add for it without SFTPGo (Trash today), one capability flag at a
 * time. Nothing here keys on a provider type, so a feature added to another
 * backend needs only its flag flipped.
 */
export const SFTPGO_FEATURE_KEYS = [
  "index",
  "shares",
  "office",
] as const satisfies readonly CapabilityKey[];
export type SftpgoFeatureKey = (typeof SFTPGO_FEATURE_KEYS)[number];

/** How the storage note names each feature, and whether the phrase takes a plural verb. */
const SFTPGO_FEATURE_PHRASES: Readonly<
  Record<SftpgoFeatureKey, { readonly phrase: string; readonly plural: boolean }>
> = {
  index: { phrase: "search and thumbnails", plural: true },
  shares: { phrase: "shares", plural: true },
  office: { phrase: "Office", plural: false },
};

/** True for storage that only moves files: none of the features fdrive builds on SFTPGo. */
export function isFilesOnly(capabilities: ProviderCapabilities): boolean {
  return SFTPGO_FEATURE_KEYS.every((key) => !capabilities[key]);
}

/**
 * One line said wherever someone picks or adds storage that lacks a feature
 * fdrive builds on SFTPGo, before they miss it. Derived from the flags, so
 * it names only what this storage lacks and disappears once it lacks
 * nothing. "Files only." leads when it lacks all of them.
 */
export function storageNote(capabilities: ProviderCapabilities): string | null {
  const missing = SFTPGO_FEATURE_KEYS.filter((key) => !capabilities[key]);
  const first = missing[0];
  if (first === undefined) return null;
  const phrases = missing.map((key) => SFTPGO_FEATURE_PHRASES[key].phrase);
  const list =
    phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
  const verb = missing.length > 1 || SFTPGO_FEATURE_PHRASES[first].plural ? "work" : "works";
  const lead = missing.length === SFTPGO_FEATURE_KEYS.length ? "Files only. " : "";
  const sentence = `${list} ${verb} with SFTPGo storage, not here.`;
  return `${lead}${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Every capability set to `value`; for tests and for "this provider type can do nothing here". */
export const allCapabilities = (value: boolean): ProviderCapabilities =>
  Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, value])) as unknown as ProviderCapabilities;

/**
 * What the file browser assumes before `/auth/me` has answered: everything
 * an SFTPGo login can do, except Trash, whose "Move to Trash" label must
 * wait for the login's configuration. This is exactly what the browser
 * showed before capabilities existed, so the common case never flickers.
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  ...allCapabilities(true),
  trash: false,
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
