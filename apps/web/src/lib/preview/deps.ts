/**
 * Single indirection point for the modules another chunk builds in
 * parallel: `src/lib/api/client.ts` (`apiClient`), `src/lib/api/keys.ts`
 * (`queryKeys`), and `src/lib/files/path-url.ts` (`pathToHref`,
 * `viewHref`, `segmentsToPath`). Everything in `components/preview` and
 * `components/inspector` imports these names from here rather than from
 * the real paths directly, so that once the real modules exist the
 * integration chunk only has to repoint the three re-exports below
 * instead of every call site.
 */
export type { ApiClient } from "./_stubs/api-client";
export { apiClient } from "./_stubs/api-client";
export { queryKeys } from "./_stubs/keys";
export { pathToHref, segmentsToPath, viewHref } from "./_stubs/path-url";
