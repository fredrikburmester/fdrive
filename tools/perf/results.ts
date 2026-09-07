/** The structured result every perf scenario returns. */
export interface ScenarioResult {
  readonly name: string;
  readonly samplesMs: readonly number[];
  readonly warmupCount?: number;
  readonly uniquePaths?: number;
  readonly verifiedCount?: number;
  readonly maxMounted?: number;
  readonly diagnostics?: unknown;
  readonly completedBytes?: readonly number[];
  readonly expectedBytes?: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly requestsPerSecond: number;
  readonly bytesPerSecond?: number;
  /** Total wall time for scenarios measured as one batch rather than a load test (e.g. uploadSmallBurst). */
  readonly wallTimeMs?: number;
  readonly errors: number;
}

/**
 * Linear-interpolation percentile over an already sorted-ascending array,
 * the same method most load-testing tools use. Pure: given the same sorted
 * array and percentile it always returns the same value.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) {
    return Number.NaN;
  }
  if (sortedAscending.length === 1) {
    return sortedAscending[0] as number;
  }
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sortedAscending.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedAscending[lowerIndex] as number;
  const upper = sortedAscending[upperIndex] as number;
  const weight = rank - lowerIndex;
  return lower + (upper - lower) * weight;
}

export interface LatencyStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * Computes p50/p95/p99 from a (not necessarily sorted) array of latency
 * samples in milliseconds. Pure: does not mutate its input.
 */
export function computeLatencyStats(latenciesMs: readonly number[]): LatencyStats {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * Combines latency samples plus the scenario's other measurements into the
 * shared `ScenarioResult` shape. Pure: no I/O, only shapes data already
 * collected by the caller.
 */
export function toScenarioResult(
  name: string,
  latenciesMs: readonly number[],
  requestsPerSecond: number,
  errors: number,
  extra: Partial<
    Omit<
      ScenarioResult,
      "name" | "samplesMs" | "p50Ms" | "p95Ms" | "p99Ms" | "requestsPerSecond" | "errors"
    >
  > = {},
): ScenarioResult {
  const stats = computeLatencyStats(latenciesMs);
  return {
    ...extra,
    name,
    samplesMs: [...latenciesMs],
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
    requestsPerSecond,
    errors,
    ...(extra.bytesPerSecond !== undefined ? { bytesPerSecond: extra.bytesPerSecond } : {}),
    ...(extra.wallTimeMs !== undefined ? { wallTimeMs: extra.wallTimeMs } : {}),
  };
}
