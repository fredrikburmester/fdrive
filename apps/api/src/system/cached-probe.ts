/**
 * Wraps an async probe so that concurrent callers share one in-flight call
 * and a settled result is reused for `ttlMs`. `GET /api/v1/health` is public
 * and unauthenticated, and its subsystem reachability check fans out to
 * every sidecar; without this, each health request would cost one outbound
 * request per sidecar, which would let an anonymous caller drive load at the
 * indexer, embed, OCR and office servers. A failed probe is cached for the
 * same window: a sidecar that is down stays "unreachable" for `ttlMs`
 * rather than being re-probed on every request.
 */
export interface CachedProbeOptions {
  readonly ttlMs: number;
  readonly clock?: () => number;
}

export function createCachedProbe<T>(
  probe: () => Promise<T>,
  options: CachedProbeOptions,
): () => Promise<T> {
  const now = options.clock ?? (() => Date.now());
  let inFlight: Promise<T> | null = null;
  let cached: { readonly value: T; readonly expiresAt: number } | null = null;
  return () => {
    if (cached !== null && cached.expiresAt > now()) {
      return Promise.resolve(cached.value);
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = probe()
      .then((value) => {
        cached = { value, expiresAt: now() + options.ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
