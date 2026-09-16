import type { SortSpec } from "./sorting";
import type { ViewMode } from "./view-mode";

/** The server's pin for one folder: either part is null when only the other is pinned. */
export interface FolderPin {
  readonly path: string;
  readonly mode: ViewMode | null;
  readonly sort?: SortSpec | null | undefined;
}

/** Exact paths only: parent pins never change a child's view. */
export function resolveFolderView(
  path: string,
  pin: FolderPin | null | undefined,
  globalDefault: ViewMode,
): ViewMode {
  return pin?.path === path && pin.mode !== null ? pin.mode : globalDefault;
}

/** Exact paths only: parent pins never change a child's sort. */
export function resolveFolderSort(
  path: string,
  pin: FolderPin | null | undefined,
  globalDefault: SortSpec,
): SortSpec {
  return pin?.path === path && pin.sort != null ? pin.sort : globalDefault;
}
