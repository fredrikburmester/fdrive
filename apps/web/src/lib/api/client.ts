import { createApiClient } from "@fdrive/contracts";

/**
 * The browser-side API client. `baseUrl` is empty so every request is
 * same-origin and goes through the Next.js rewrite in `next.config.ts`
 * (`/api/*` -> `API_INTERNAL_URL`), which keeps the session cookie
 * first-party.
 */
export const apiClient = createApiClient({ baseUrl: "" });
