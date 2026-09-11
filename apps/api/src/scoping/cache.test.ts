import { describe, expect, it, vi } from "vitest";
import { createScopeCache } from "./cache.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildClock(startMs: number) {
  let now = startMs;
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe("createScopeCache", () => {
  it("caches a resolved value within the TTL", async () => {
    const clockCtl = buildClock(0);
    const cache = createScopeCache<number>({ clock: clockCtl.clock, ttlMs: 1000 });
    const compute = vi.fn(async () => 1);

    expect(await cache.get("k", compute)).toBe(1);
    expect(await cache.get("k", compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the TTL expires", async () => {
    const clockCtl = buildClock(0);
    const cache = createScopeCache<number>({ clock: clockCtl.clock, ttlMs: 1000 });
    let value = 1;
    const compute = vi.fn(async () => value);

    expect(await cache.get("k", compute)).toBe(1);
    clockCtl.advance(1001);
    value = 2;
    expect(await cache.get("k", compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent calls for the same key into one compute", async () => {
    const cache = createScopeCache<number>();
    const d = deferred<number>();
    const compute = vi.fn(() => d.promise);

    const first = cache.get("k", compute);
    const second = cache.get("k", compute);
    d.resolve(42);

    expect(await first).toBe(42);
    expect(await second).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection, and lets the next call retry", async () => {
    const cache = createScopeCache<number>();
    const failing = deferred<number>();
    const computeFail = vi.fn(() => failing.promise);

    const pending = cache.get("k", computeFail);
    failing.reject(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");

    const computeOk = vi.fn(async () => 7);
    expect(await cache.get("k", computeOk)).toBe(7);
    expect(computeOk).toHaveBeenCalledTimes(1);
  });

  it("a new key never joins a different key's in-flight compute", async () => {
    const cache = createScopeCache<number>();
    const d = deferred<number>();
    const computeA = vi.fn(() => d.promise);
    const computeB = vi.fn(async () => 99);

    const pendingA = cache.get("a", computeA);
    expect(await cache.get("b", computeB)).toBe(99);
    d.resolve(1);
    expect(await pendingA).toBe(1);
    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(1);
  });

  it("invalidatePrefix removes matching cached entries so the next call recomputes", async () => {
    const cache = createScopeCache<number>();
    let value = 1;
    const compute = vi.fn(async () => value);

    expect(await cache.get("identity-1:a", compute)).toBe(1);
    expect(await cache.get("identity-2:a", compute)).toBe(1);

    cache.invalidatePrefix("identity-1:");
    value = 2;

    expect(await cache.get("identity-1:a", compute)).toBe(2);
    expect(await cache.get("identity-2:a", compute)).toBe(1);
  });

  it("invalidatePrefix drops an in-flight entry so a fresh call starts a new compute", async () => {
    const cache = createScopeCache<number>();
    const d = deferred<number>();
    const computeSlow = vi.fn(() => d.promise);

    const stalePending = cache.get("identity-1:a", computeSlow);
    cache.invalidatePrefix("identity-1:");

    const compute2 = vi.fn(async () => 5);
    expect(await cache.get("identity-1:a", compute2)).toBe(5);
    expect(compute2).toHaveBeenCalledTimes(1);

    d.resolve(1);
    expect(await stalePending).toBe(1);
    expect(await cache.get("identity-1:a", async () => 99)).toBe(5);
  });

  it("invalidatePrefix leaves an in-flight entry for a different identity untouched", async () => {
    const cache = createScopeCache<number>();
    const dMatching = deferred<number>();
    const dOther = deferred<number>();
    const computeMatching = vi.fn(() => dMatching.promise);
    const computeOther = vi.fn(() => dOther.promise);

    const matchingPending = cache.get("identity-1:a", computeMatching);
    const otherPending = cache.get("identity-2:a", computeOther);

    cache.invalidatePrefix("identity-1:");

    dMatching.resolve(1);
    dOther.resolve(2);
    expect(await matchingPending).toBe(1);
    expect(await otherPending).toBe(2);

    // The untouched in-flight entry for identity-2 is still cached.
    const shouldNotRun = vi.fn(async () => 999);
    expect(await cache.get("identity-2:a", shouldNotRun)).toBe(2);
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it("evicts the oldest entry once the cap is exceeded", async () => {
    const cache = createScopeCache<number>({ maxEntries: 2 });
    const compute = vi.fn(async (n: number) => n);

    expect(await cache.get("a", () => compute(1))).toBe(1);
    expect(await cache.get("b", () => compute(2))).toBe(2);
    expect(await cache.get("c", () => compute(3))).toBe(3);

    // "a" was evicted as the oldest; a fresh call for it recomputes.
    const recompute = vi.fn(async () => 100);
    expect(await cache.get("a", recompute)).toBe(100);
    expect(recompute).toHaveBeenCalledTimes(1);

    // "c" (most recently written) is still cached.
    const shouldNotRun = vi.fn(async () => 999);
    expect(await cache.get("c", shouldNotRun)).toBe(3);
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it("uses the real clock when none is supplied", async () => {
    const cache = createScopeCache<number>();
    expect(await cache.get("k", async () => 1)).toBe(1);
  });
});

it("old completion cannot delete a replacement in-flight entry", async () => {
  const cache = createScopeCache<number>();
  const old = deferred<number>();
  const fresh = deferred<number>();
  const first = cache.get("key", () => old.promise);
  cache.invalidatePrefix("key");
  const second = cache.get("key", () => fresh.promise);
  old.resolve(1);
  await first;
  const compute = vi.fn(async () => 99);
  const third = cache.get("key", compute);
  fresh.resolve(2);
  expect(await second).toBe(2);
  expect(await third).toBe(2);
  expect(compute).not.toHaveBeenCalled();
});
