import { createApiClient } from "@fdrive/contracts";

/**
 * Minimal stand-in for the shell chunk's `src/lib/api/client.ts`. Builds a
 * same-origin `ApiClient` using SDK defaults (relative `baseUrl`, the
 * ambient `fetch`, no forced identity). `deps.ts` re-exports this until the
 * integration chunk repoints it at the real module, which will likely wire
 * in auth state and a configured base URL.
 */
export const apiClient = createApiClient();
