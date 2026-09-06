/**
 * Single seam between the upload queue and the rest of the app's shell:
 * the shell's `apiClient` (`src/lib/api/client.ts`) and `queryKeys`
 * (`src/lib/api/keys.ts`), re-exported here so nothing else in
 * `src/lib/upload` or `src/components/upload` needs to import them
 * directly.
 */
import type { ApiClient } from "@fdrive/contracts";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

export type QueryKeys = typeof queryKeys;
export { apiClient, queryKeys };

/** The narrow slice of `QueryKeys` `createDefaultOnUploaded` needs. */
export interface UploadQueryKeys {
  readonly fs: {
    readonly list: (path: string) => readonly unknown[];
  };
}

/**
 * Builds the default `onUploaded` callback for the ready-made upload store
 * singleton (`useUploadStore`, see `store.ts`): it asks the API to
 * re-fetch the affected directory listing so the cache is not left stale
 * even before the shell wires up real query-cache invalidation. The shell
 * replaces this with `useUploadStore.getState().setOnUploaded(...)`, which
 * instead calls `queryClient.invalidateQueries({ queryKey:
 * queryKeys.fs.list(parentPath) })`; this default only runs before that
 * happens (or if it never does).
 */
export function createDefaultOnUploaded(
  client: Pick<ApiClient, "list"> = apiClient,
  keys: UploadQueryKeys = queryKeys,
): (parentPath: string) => void {
  return (parentPath: string) => {
    // Referenced so the query key shape stays exercised even though this
    // default has no cache to invalidate yet.
    keys.fs.list(parentPath);
    client.list(parentPath).catch(() => {
      // Best-effort refresh; a failure here is not actionable by the caller.
    });
  };
}
