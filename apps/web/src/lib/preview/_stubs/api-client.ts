/**
 * Stand-in for `src/lib/api/client.ts`, which another chunk builds in
 * parallel. It exports a singleton `apiClient` built directly from
 * `@fdrive/contracts`'s `createApiClient`, same-origin, credentialed
 * fetch, no extra options. `deps.ts` re-exports this so the integration
 * chunk can repoint a single import instead of editing every file in
 * `components/preview` and `components/inspector`.
 */
import { type ApiClient, createApiClient } from "@fdrive/contracts";

export type { ApiClient };

export const apiClient: ApiClient = createApiClient();
