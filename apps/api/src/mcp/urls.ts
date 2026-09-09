/**
 * Builds the fdrive URL for a file at `virtualPath` (a preview/download
 * route), or for a folder (a browse route). Prefixed with `publicUrl` (the
 * owner-chosen server address) when set; a relative path otherwise (still
 * useful to an LLM, just not clickable without a base).
 */
export function fileUrl(publicUrl: string | null, virtualPath: string): string {
  return `${publicUrl ?? ""}/view${virtualPath}`;
}

export function folderUrl(publicUrl: string | null, virtualPath: string): string {
  return `${publicUrl ?? ""}/files${virtualPath}`;
}
