/**
 * Reads a bundled optional-worker controller's `GET /runtime` document (the
 * embed, image-embed, Tika and Office containers each run one on their own
 * status port). The controller is a tiny process that stays up even while the
 * worker it manages is off or could not start, so it is the only place that
 * can tell "the model server is down because the network is broken" apart
 * from "the controller gave up starting it". Its `error` field is always one
 * of the controller's own fixed literals (for example "worker exceeded
 * bounded startup retries"), never an upstream message, which is why it is
 * safe to surface on the public health endpoint and in feature details.
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

/** A controller's status document, or `null` when it cannot be reached or does not answer with one. */
export async function fetchRuntimeStatus(
  baseUrl: string,
  port: string | null,
  fetchImpl: typeof fetch,
  timeoutMs = 2000,
): Promise<RuntimeStatus | null> {
  try {
    const url = new URL(baseUrl);
    if (port !== null) url.port = port;
    url.pathname = "/runtime";
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
