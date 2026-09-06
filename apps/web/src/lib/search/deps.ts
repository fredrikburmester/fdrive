/**
 * The single seam between this chunk (search) and pieces owned by parallel
 * chunks: the shared API client, and the file browser's icon component and
 * path/URL helpers. Import these here rather than reaching into other
 * chunks' directories directly from search components.
 */

export { FileIcon } from "@/components/files/file-icon";
export { apiClient } from "@/lib/api/client";
export { pathFromFilesPathname, pathToHref, viewHref } from "@/lib/files/path-url";
export { revealTarget } from "@/lib/files/reveal";
export type { StorageLike } from "@/lib/files/storage";
export { readJson, writeJson } from "@/lib/files/storage";
