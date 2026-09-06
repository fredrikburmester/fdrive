import type { FsEntry } from "@fdrive/contracts";

/** The natural-order, case-insensitive collator the file browser sorts by. */
const BROWSER_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface SiblingNavigation {
  /** Path of the previous previewable entry, or `null` at the first one. */
  readonly prev: string | null;
  /** Path of the next previewable entry, or `null` at the last one. */
  readonly next: string | null;
  /** Zero-based position of `currentPath` among previewable entries, or -1 when it is not one of them. */
  readonly index: number;
  /** Count of previewable entries considered. */
  readonly total: number;
}

/**
 * Computes prev/next navigation for the preview route over `entries`,
 * restricted to files (directories are excluded) and sorted by name with
 * the same collator the browser uses. `currentPath` need not be present in
 * `entries` (for example when the preview was opened by a direct link);
 * in that case `index` is -1 and both `prev` and `next` are `null`.
 */
export function siblingNavigation(
  entries: readonly FsEntry[],
  currentPath: string,
): SiblingNavigation {
  const previewable = entries
    .filter((entry) => entry.kind === "file")
    .slice()
    .sort((a, b) => BROWSER_COLLATOR.compare(a.name, b.name));

  const index = previewable.findIndex((entry) => entry.path === currentPath);
  const total = previewable.length;

  if (index === -1) {
    return { prev: null, next: null, index, total };
  }

  const prevEntry = index > 0 ? previewable[index - 1] : undefined;
  const nextEntry = index < total - 1 ? previewable[index + 1] : undefined;

  return {
    prev: prevEntry?.path ?? null,
    next: nextEntry?.path ?? null,
    index,
    total,
  };
}
