/**
 * The two facts a conflict check compares: the entry's last-known
 * `modifiedAt` (an ISO timestamp, compared as a string) and `size` in
 * bytes. `baseline` is what the editor loaded (or last saved); `current`
 * is a fresh `stat` taken right before the save request.
 */
export interface SaveBaseline {
  readonly modifiedAt: string;
  readonly size: number;
}

export type SaveDecision = "save" | "conflict";

/**
 * Decides whether a save can proceed straight away or must first ask the
 * user, by comparing `current` (a fresh stat, taken immediately before
 * saving) against `baseline` (what the editor's document is based on). Any
 * difference in `modifiedAt` or `size` means something else changed the
 * file since it was loaded, so the caller should show a conflict dialog
 * instead of silently overwriting it.
 */
export function decideSave(baseline: SaveBaseline, current: SaveBaseline): SaveDecision {
  if (baseline.modifiedAt !== current.modifiedAt || baseline.size !== current.size) {
    return "conflict";
  }
  return "save";
}
