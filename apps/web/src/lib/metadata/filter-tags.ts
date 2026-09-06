import type { Tag } from "@fdrive/contracts";

/**
 * Case-insensitive substring filter for the `TagPicker`'s type-to-filter
 * search box. An empty (or whitespace-only) `query` returns every tag,
 * unfiltered.
 */
export function filterTags(tags: readonly Tag[], query: string): Tag[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...tags];
  }
  return tags.filter((tag) => tag.name.toLowerCase().includes(needle));
}

/**
 * Whether `query` (trimmed) has no case-insensitive exact match among
 * `tags`' names: the condition for showing the `TagPicker`'s "Create tag
 * '<name>'" option. Also false for an empty query, since there is nothing
 * to create yet.
 */
export function hasNoExactMatch(tags: readonly Tag[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return false;
  }
  return !tags.some((tag) => tag.name.toLowerCase() === needle);
}
