import { type ApiClient, createApiClient } from "@fdrive/contracts";

/**
 * Stand-in for the shell's `apiClient` singleton (owned by another chunk,
 * `src/lib/api/client.ts`). Built from `@fdrive/contracts`'s own
 * `createApiClient` with default options (same-origin, `globalThis.fetch`),
 * which is a reasonable value even before the shell exists. `deps.ts`
 * re-exports this; the integration chunk repoints that re-export at the
 * real module and this file can then be deleted.
 */
export const apiClient: ApiClient = createApiClient();
