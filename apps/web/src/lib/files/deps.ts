/**
 * The single seam between this chunk (the file browser) and the pieces
 * owned by parallel chunks: the shell's query keys and API client, the
 * shell's `PageHeader`, and the upload chunk's internal drag-and-drop
 * helpers. None of `@/lib/api/keys`, `@/lib/api/client`,
 * `@/components/shell/page-header`, or `@/lib/dnd` exist in this worktree,
 * so every export below currently resolves to a local stand-in under
 * `./_stubs`. The integration chunk repoints these exports at the real
 * modules once they land; nothing outside this file should import from
 * `./_stubs` directly.
 */
export { apiClient } from "./_stubs/api-client";
export {
  type DraggedPathsCarrier,
  INTERNAL_DND_TYPE,
  readDraggedPaths,
  writeDraggedPaths,
} from "./_stubs/dnd";
export { queryKeys } from "./_stubs/keys";
export { PageHeader, type PageHeaderProps } from "./_stubs/page-header";
