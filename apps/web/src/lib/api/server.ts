import { type ApiClient, createApiClient } from "@fdrive/contracts";
import { headers } from "next/headers";

const DEFAULT_API_INTERNAL_URL = "http://localhost:3001";

/**
 * Builds the base URL for server-to-server calls to the API: the
 * `API_INTERNAL_URL` environment variable, falling back to the local dev
 * default when unset.
 */
export function resolveApiInternalUrl(env: NodeJS.ProcessEnv): string {
  return env.API_INTERNAL_URL ?? DEFAULT_API_INTERNAL_URL;
}

/**
 * Builds the `fetch` implementation used by the server-side API client: a
 * thin wrapper around the given `fetchImpl` that forwards `cookie` (the
 * incoming request's cookie header) to the API, so the API sees the
 * caller's session even though the request itself originates on the
 * server.
 */
export function buildForwardingFetch(fetchImpl: typeof fetch, cookie: string | null): typeof fetch {
  return (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    if (cookie !== null) {
      requestHeaders.set("cookie", cookie);
    }
    return fetchImpl(input, { ...init, headers: requestHeaders });
  };
}

/**
 * Builds an `ApiClient` for use in React Server Components and route
 * handlers. Talks directly to `API_INTERNAL_URL` (bypassing the Next.js
 * rewrite, which only applies to browser requests) and forwards the
 * incoming request's `cookie` header so the API authenticates the caller's
 * session.
 */
export async function serverApiClient(): Promise<ApiClient> {
  const headerList = await headers();
  const cookie = headerList.get("cookie");

  return createApiClient({
    baseUrl: resolveApiInternalUrl(process.env),
    fetch: buildForwardingFetch(globalThis.fetch, cookie),
  });
}
