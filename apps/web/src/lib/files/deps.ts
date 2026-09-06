/**
 * The single seam between this chunk (the file browser) and the pieces
 * owned by parallel chunks: the shell's query keys and API client, the
 * shell's `PageHeader`, and the upload chunk's internal drag-and-drop
 * helpers.
 */

export type { PageHeaderProps } from "@/components/shell/page-header";
export { PageHeader } from "@/components/shell/page-header";
export { apiClient } from "@/lib/api/client";
export { queryKeys } from "@/lib/api/keys";
export { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/dnd";
