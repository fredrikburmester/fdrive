/**
 * Single indirection point for the modules the shell and file-browser
 * chunks own: `src/lib/api/client.ts` (`apiClient`), `src/lib/api/keys.ts`
 * (`queryKeys`), and `src/lib/files/path-url.ts` (`pathToHref`,
 * `viewHref`, `segmentsToPath`). Everything in `components/preview` and
 * `components/inspector` imports these names from here rather than from
 * the real paths directly, so a future seam only has to repoint the
 * re-exports below instead of every call site.
 */
import type { ApiClient } from "@fdrive/contracts";

export { apiClient } from "@/lib/api/client";
export { queryKeys } from "@/lib/api/keys";
export { pathToHref, segmentsToPath, viewHref } from "@/lib/files/path-url";
export type { ApiClient };
