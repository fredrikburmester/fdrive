const WINDOW_MS = 60_000;

/** Bounded fixed windows. At capacity, new keys fail closed until an old window expires. */
export function createShareLimiter(clock: () => Date, capacity = 10000) {
  type Window = { expires: number; requests: number; credentials: number };
  type Classification = { known: boolean; expires: number };
  const knownWindows = new Map<string, Window>();
  // Unknown IDs share one key per address. Keeping them separate prevents
  // arbitrary UUIDs from consuming the capacity reserved for real shares.
  const unknownWindows = new Map<string, Window>();
  // This cache only selects a limiter bucket. Public handlers still load the
  // share again before serving anything, so stale entries never authorize it.
  const classifications = new Map<string, Classification>();
  const pendingClassifications = new Map<string, Promise<boolean>>();

  function sweepClassifications(now: number): void {
    for (const [id, value] of classifications) if (value.expires <= now) classifications.delete(id);
  }

  async function classify(
    shareId: string,
    load: () => Promise<boolean>,
    now: number,
  ): Promise<boolean> {
    const cached = classifications.get(shareId);
    if (cached !== undefined && cached.expires > now) {
      classifications.delete(shareId);
      classifications.set(shareId, cached);
      return cached.known;
    }
    classifications.delete(shareId);
    const existing = pendingClassifications.get(shareId);
    if (existing !== undefined) return existing;

    const pending = load();
    if (pendingClassifications.size < capacity) pendingClassifications.set(shareId, pending);
    let known: boolean;
    try {
      known = await pending;
    } finally {
      if (pendingClassifications.get(shareId) === pending) pendingClassifications.delete(shareId);
    }
    if (capacity > 0) {
      const resolvedAt = clock().getTime();
      if (classifications.size >= capacity) sweepClassifications(resolvedAt);
      if (classifications.size >= capacity) {
        const oldest = classifications.keys().next().value;
        if (oldest !== undefined) classifications.delete(oldest);
      }
      classifications.set(shareId, { known, expires: resolvedAt + WINDOW_MS });
    }
    return known;
  }

  function getWindow(
    windows: Map<string, Window>,
    key: string,
    now: number,
    create = true,
  ): Window | undefined {
    let window = windows.get(key);
    if (window !== undefined && window.expires <= now) {
      windows.delete(key);
      window = undefined;
    }
    if (window === undefined && create) {
      if (windows.size >= capacity) {
        for (const [candidate, value] of windows)
          if (value.expires <= now) windows.delete(candidate);
        if (windows.size >= capacity) return undefined;
      }
      window = { expires: now + WINDOW_MS, requests: 0, credentials: 0 };
      windows.set(key, window);
    }
    return window;
  }

  function count(window: Window, credential: boolean): boolean {
    window.requests++;
    if (credential) window.credentials++;
    return window.requests <= 120 && window.credentials <= 10;
  }

  return {
    async allow(
      ip: string,
      shareId: string,
      credential: boolean,
      loadClassification: () => Promise<boolean>,
    ): Promise<boolean> {
      const now = clock().getTime();
      if (capacity <= 0) return false;
      const knownKey = JSON.stringify([ip, shareId]);
      const existingKnownWindow = getWindow(knownWindows, knownKey, now, false);
      if (existingKnownWindow !== undefined) return count(existingKnownWindow, credential);

      const known = await classify(shareId, loadClassification, now);
      const window = getWindow(
        known ? knownWindows : unknownWindows,
        known ? knownKey : ip,
        clock().getTime(),
      );
      return window === undefined ? false : count(window, credential);
    },
  };
}
export type ShareLimiter = ReturnType<typeof createShareLimiter>;
