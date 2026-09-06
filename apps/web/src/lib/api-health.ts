/**
 * Result of probing the API health endpoint. A successful probe always
 * carries a version string (falling back to "unknown" when the response
 * body does not include one); a failed probe carries no other data,
 * because the caller only needs to know whether the API is reachable.
 */
export type ApiHealthResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false };

const HEALTH_PATH = "/api/v1/health";
const DEFAULT_TIMEOUT_MS = 2000;

function parseVersion(data: unknown): string {
  if (typeof data === "object" && data !== null && "version" in data) {
    const value = (data as Record<string, unknown>).version;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "unknown";
}

/**
 * Probes the API health endpoint at `${baseUrl}/api/v1/health`. Takes the
 * fetch implementation as an argument so it can be unit tested with a stub,
 * never throws (network errors, non-2xx responses, malformed bodies, and
 * timeouts all resolve to `{ ok: false }`), and always resolves within
 * `timeoutMs` milliseconds.
 */
export async function fetchApiHealth(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ApiHealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}${HEALTH_PATH}`, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false };
    }

    const data: unknown = await response.json();
    return { ok: true, version: parseVersion(data) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
