import { describe, expect, it } from "vitest";
import { computeLatencyStats, percentile, toScenarioResult } from "./results.js";

describe("percentile", () => {
  it("returns NaN for an empty array", () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it("returns the single value for a one-element array regardless of p", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns the min at p0 and the max at p100", () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(5);
  });

  it("interpolates the median for an even-length array", () => {
    // rank = 0.5 * 3 = 1.5 -> halfway between index 1 (2) and index 2 (3).
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("matches an exact element when the rank lands on an integer index", () => {
    // 10 elements, p90 -> rank = 0.9 * 9 = 8.1, not integer; use p0/p100 covered above.
    // Use an 11-element array so p50 lands exactly on the middle index.
    const sorted = Array.from({ length: 11 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(6);
  });

  it("clamps percentiles outside [0, 100]", () => {
    expect(percentile([1, 2, 3], -10)).toBe(1);
    expect(percentile([1, 2, 3], 250)).toBe(3);
  });
});

describe("computeLatencyStats", () => {
  it("does not mutate its input array", () => {
    const input = [5, 1, 3, 2, 4];
    const copy = [...input];
    computeLatencyStats(input);
    expect(input).toEqual(copy);
  });

  it("sorts before computing percentiles", () => {
    const stats = computeLatencyStats([5, 1, 3, 2, 4]);
    expect(stats.p50).toBe(3);
  });

  it("returns NaN stats for an empty sample set", () => {
    const stats = computeLatencyStats([]);
    expect(stats.p50).toBeNaN();
    expect(stats.p95).toBeNaN();
    expect(stats.p99).toBeNaN();
  });
});

describe("toScenarioResult", () => {
  it("fills in latency stats, requestsPerSecond, and errors", () => {
    const result = toScenarioResult("demo", [10, 20, 30], 123, 0);
    expect(result.name).toBe("demo");
    expect(result.requestsPerSecond).toBe(123);
    expect(result.errors).toBe(0);
    expect(result.p50Ms).toBe(20);
  });

  it("omits bytesPerSecond and wallTimeMs when not provided", () => {
    const result = toScenarioResult("demo", [1], 1, 0);
    expect(result.bytesPerSecond).toBeUndefined();
    expect(result.wallTimeMs).toBeUndefined();
    expect("bytesPerSecond" in result).toBe(false);
    expect("wallTimeMs" in result).toBe(false);
  });

  it("includes bytesPerSecond and wallTimeMs when provided", () => {
    const result = toScenarioResult("demo", [1], 1, 0, {
      bytesPerSecond: 1024,
      wallTimeMs: 5000,
    });
    expect(result.bytesPerSecond).toBe(1024);
    expect(result.wallTimeMs).toBe(5000);
  });
});
