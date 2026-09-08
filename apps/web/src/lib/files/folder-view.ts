import type { ViewMode } from "./view-mode";

/** Exact paths only: parent pins never change a child's view. */
export function resolveFolderView(
  path: string,
  pin: { readonly path: string; readonly mode: ViewMode } | null | undefined,
  globalDefault: ViewMode,
): ViewMode {
  return pin?.path === path ? pin.mode : globalDefault;
}
