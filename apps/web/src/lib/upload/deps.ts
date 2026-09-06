/**
 * Single seam between the upload queue and the rest of the app's shell.
 * Everything the upload queue needs from `src/lib/api/client.ts` and
 * `src/lib/api/keys.ts` (built by another chunk in parallel) is imported
 * here, from the local `_stubs/`, and re-exported. Once those modules
 * exist, the integration chunk repoints the two imports below at them and
 * deletes `_stubs/`; nothing else in `src/lib/upload` or
 * `src/components/upload` needs to change.
 */
import type { ApiClient } from "@fdrive/contracts";
import { apiClient } from "./_stubs/api-client.js";
import { type QueryKeys, queryKeys } from "./_stubs/keys.js";

export type { QueryKeys };
export { apiClient, queryKeys };

/**
 * Builds the default `onUploaded` callback for the ready-made upload store
 * singleton (`useUploadStore`, see `store.ts`): it asks the API to
 * re-fetch the affected directory listing so the cache is not left stale
 * even before the shell wires up real query-cache invalidation. The shell
 * is expected to call `useUploadStore.getState().setOnUploaded(...)` with a
 * callback that instead calls `queryClient.invalidateQueries({ queryKey:
 * queryKeys.fs.list(parentPath) })`; this is only a reasonable default
 * until it does.
 */
export function createDefaultOnUploaded(
  client: Pick<ApiClient, "list"> = apiClient,
  keys: QueryKeys = queryKeys,
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
