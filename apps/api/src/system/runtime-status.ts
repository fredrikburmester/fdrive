/**
 * Reads an optional worker's `GET /runtime` document. The ml service serves
 * one per unit under that unit's path prefix; the Office container runs a
 * small controller that serves one on its own status port. Either stays up
 * while the worker it speaks for is off or could not start, so it is the only
 * place that can tell "the model server is down because the network is
 * broken" apart from "it gave up starting". Its `error` field is always one
 * of a fixed set of literals (for example "worker exceeded bounded startup
 * retries"), never an upstream message, which is why it is safe to surface on
 * the public health endpoint and in feature details.
 */

/** The bounded set of shapes a controller's status document can take. */
export interface RuntimeStatus {
  readonly status: string;
  readonly error: string | null;
}

const MAX_ERROR_LENGTH = 200;

/** Extracts a controller's `error` when it is a non-empty string, capped so a malformed document cannot bloat a response. */
export function runtimeError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string" || error.length === 0) return null;
  return error.slice(0, MAX_ERROR_LENGTH);
}

/**
 * A status document, or `null` when it cannot be reached or does not answer
 * with one. With a `port`, the document is the one a controller serves at the
 * root of that port on `baseUrl`'s host. Without one, `baseUrl` is a runtime
 * URL and `/runtime` is added below its path, so the units of one server keep
 * their own documents.
 */
export async function fetchRuntimeStatus(
  baseUrl: string,
  port: string | null,
  fetchImpl: typeof fetch,
  timeoutMs = 2000,
): Promise<RuntimeStatus | null> {
  try {
    const url = new URL(baseUrl);
    if (port === null) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/runtime`;
    } else {
      url.port = port;
      url.pathname = "/runtime";
    }
    url.search = "";
    url.hash = "";
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const status = (body as { status?: unknown }).status;
    if (typeof status !== "string") return null;
    return { status, error: runtimeError(body) };
  } catch {
    return null;
  }
}

/**
 * The reason a controller reports for a worker that could not start, or
 * `null` when the controller is unreachable or not in a failed state. A
 * failed controller with no reason still counts as failed.
 */
export function runtimeFailure(runtime: RuntimeStatus | null): string | null {
  if (runtime === null || runtime.status !== "failed") return null;
  return runtime.error ?? "Worker could not be started.";
}
