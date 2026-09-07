/**
 * Single indirection point for the modules this chunk (trash) depends on
 * but does not own: the shell's API client and query keys. Every other
 * module under `lib/trash` and `components/trash` imports these two names
 * from here rather than from the real paths directly, so a future seam
 * only has to repoint the re-exports below instead of every call site.
 */
export { apiClient, snapshotTabApiClient } from "@/lib/api/client";
export { queryKeys } from "@/lib/api/keys";
