import { ApiHttpError } from "../errors.js";

/** One bucket per authenticated account: changing sessions or file IDs cannot evade it. */
export function createActivityLimiter(
  limit: number,
  clock: () => Date = () => new Date(),
  capacity = 10_000,
) {
  const windows = new Map<string, { until: number; count: number }>();
  return (accountId: string) => {
    const now = clock().getTime();
    let window = windows.get(accountId);
    if (!window || window.until <= now) {
      for (const [id, value] of windows) if (value.until <= now) windows.delete(id);
      if (windows.size >= capacity)
        throw new ApiHttpError("rate_limited", "Activity is busy; retry in a minute");
      window = { until: now + 60_000, count: 0 };
      windows.set(accountId, window);
    }
    if (++window.count > limit)
      throw new ApiHttpError("rate_limited", "Too many activity requests; retry in a minute");
  };
}
