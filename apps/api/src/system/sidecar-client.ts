import type { z } from "zod";

/** How long a sidecar call is allowed to take before it counts as unreachable. */
export const DEFAULT_SIDECAR_TIMEOUT_MS = 3000;

/**
 * The result of one call to a sidecar's internal HTTP API. `ok: false` is
 * returned rather than thrown for every kind of failure (network error,
 * timeout, non-2xx status, unparsable body, a body that fails the schema),
 * so a down or misbehaving sidecar renders as "unreachable" in the System
 * pages instead of a 500.
 */
export type SidecarResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: "unreachable" | "invalid";
      readonly detail: string;
      /** The sidecar's HTTP status, when the failure was a non-2xx response
       * rather than a network error or an unparsable/invalid body. Lets a
       * caller distinguish a specific status (e.g. 409) from "unreachable"
       * in general. */
      readonly status?: number;
      /** The non-2xx response's decoded JSON body, when it sent one. A sidecar
       * that refuses an operation explains why in the body, and that reason is
       * what the operator needs to see; the caller validates its own shape. */
      readonly body?: unknown;
    };

export interface SidecarRequestDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface SidecarRequestOptions {
  readonly method?: string;
  readonly jsonBody?: unknown;
  /** Overrides `deps.timeoutMs` for one call. A restore copies file bytes, so
   * it needs more than the health-check budget the default is sized for. */
  readonly timeoutMs?: number;
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
}

/**
 * Strips a trailing slash from `baseUrl` and joins it with `path`, so
 * callers never have to worry about a doubled or missing slash.
 */
export function joinSidecarUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Calls a sidecar's internal HTTP API at `${baseUrl}${path}`, with a
 * `timeoutMs` (default `DEFAULT_SIDECAR_TIMEOUT_MS`) abort, and validates
 * the JSON response against `schema`, tolerating extra fields the sidecar
 * may add later. Never throws: every failure mode is reported through the
 * returned `SidecarResult`.
 */
export async function callSidecar<T>(
  baseUrl: string,
  path: string,
  schema: z.ZodType<T>,
  options: SidecarRequestOptions,
  deps: SidecarRequestDeps,
): Promise<SidecarResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? deps.timeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS,
  );

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      ...(options.jsonBody !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.jsonBody),
          }
        : {}),
    };

    let response: Response;
    try {
      response = await deps.fetch(joinSidecarUrl(baseUrl, path), init);
    } catch (err) {
      return { ok: false, reason: "unreachable", detail: messageFor(err) };
    }

    if (!response.ok) {
      let body: unknown;
      if (response.headers.get("content-type")?.includes("application/json") === true) {
        body = await (response.json() as Promise<unknown>).catch(() => undefined);
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      return {
        ok: false,
        reason: "unreachable",
        detail: `status ${response.status}`,
        status: response.status,
        ...(body !== undefined ? { body } : {}),
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, reason: "invalid", detail: "response was not valid JSON" };
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: "response failed contract validation" };
    }

    return { ok: true, data: parsed.data };
  } finally {
    clearTimeout(timer);
  }
}
