/**
 * Single indirection point for the modules this chunk (the in-place editor)
 * depends on but does not own: the shell's API client and query keys, the
 * file browser's path helpers, and the preview chunk's text-loading limit
 * and loader. Everything in `components/editor` imports these names from
 * here rather than from the real paths directly, so a future seam only has
 * to repoint the re-exports below instead of every call site.
 */
import type { ApiClient } from "@fdrive/contracts";

export { apiClient } from "@/lib/api/client";
export { describeApiError } from "@/lib/api/errors";
export { queryKeys } from "@/lib/api/keys";
export { pathToHref, segmentsToPath, viewHref } from "@/lib/files/path-url";
export { detectPlatform } from "@/lib/files/platform";
export { useTouchRecent } from "@/lib/metadata/queries";
export { TEXT_LIMIT_BYTES } from "@/lib/preview/kind";
export { loadText } from "@/lib/preview/text-loader";
export type { ApiClient };
