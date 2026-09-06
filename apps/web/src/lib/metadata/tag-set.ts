import type { FsEntry } from "@fdrive/contracts";

/**
 * Adds or removes `tagId` from `tagIds`, returning a new array. A no-op
 * (returns the same values, in a new array) when `checked` already matches
 * whether `tagId` is present, so callers can always spread the result
 * without checking first.
 */
export function toggleTagId(tagIds: readonly string[], tagId: string, checked: boolean): string[] {
  const has = tagIds.includes(tagId);
  if (checked === has) {
    return [...tagIds];
  }
  return checked ? [...tagIds, tagId] : tagIds.filter((id) => id !== tagId);
}

export type TagCheckState = "checked" | "unchecked" | "indeterminate";

/**
 * The checkbox state for `tagId` across a (possibly multi-entry) selection:
 * "checked" when every entry has it, "unchecked" when none do, and
 * "indeterminate" when some but not all do. An empty selection is
 * "unchecked".
 */
export function tagCheckState(
  entries: ReadonlyArray<{ readonly tagIds: readonly string[] }>,
  tagId: string,
): TagCheckState {
  if (entries.length === 0) {
    return "unchecked";
  }
  const flags = entries.map((entry) => entry.tagIds.includes(tagId));
  if (flags.every(Boolean)) {
    return "checked";
  }
  if (flags.every((flag) => !flag)) {
    return "unchecked";
  }
  return "indeterminate";
}

/**
 * Applies a `setFileTags` result to a cached listing's entries (optimistic
 * update for `useSetFileTags`): the entry at `path`, if present, gets its
 * `meta.tagIds` replaced by `tagIds` (favorite status, if any, is kept
 * unchanged). Entries for other paths, and the array itself when `path`
 * is not present, are returned unchanged (same reference) so React Query's
 * shallow-equality checks skip re-rendering unaffected subscribers.
 */
export function applyTagsToEntries(
  entries: readonly FsEntry[],
  path: string,
  tagIds: readonly string[],
): FsEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.path !== path) {
      return entry;
    }
    changed = true;
    return { ...entry, meta: { favorite: entry.meta?.favorite ?? false, tagIds: [...tagIds] } };
  });
  return changed ? next : entries.slice();
}

/**
 * Applies a favorite toggle to a cached listing's entries (optimistic
 * update for `useToggleFavorite`): the entry at `path`, if present, gets
 * its `meta.favorite` set to `favorite` (its tags, if any, are kept
 * unchanged).
 */
export function applyFavoriteToEntries(
  entries: readonly FsEntry[],
  path: string,
  favorite: boolean,
): FsEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.path !== path) {
      return entry;
    }
    changed = true;
    return { ...entry, meta: { tagIds: entry.meta?.tagIds ?? [], favorite } };
  });
  return changed ? next : entries.slice();
}
