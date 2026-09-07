/** Bounded fixed windows. At capacity, new keys fail closed until an old window expires. */
export function createShareLimiter(clock: () => Date, capacity = 10000) {
  const windows = new Map<string, { expires: number; requests: number; credentials: number }>();
  return {
    allow(ip: string, shareId: string, credential: boolean): boolean {
      const now = clock().getTime();
      for (const [key, value] of windows) if (value.expires <= now) windows.delete(key);
      const key = JSON.stringify([ip, shareId]);
      let window = windows.get(key);
      if (window === undefined) {
        if (windows.size >= capacity) return false;
        window = { expires: now + 60000, requests: 0, credentials: 0 };
        windows.set(key, window);
      }
      window.requests++;
      if (credential) window.credentials++;
      return window.requests <= 120 && window.credentials <= 10;
    },
  };
}
export type ShareLimiter = ReturnType<typeof createShareLimiter>;
