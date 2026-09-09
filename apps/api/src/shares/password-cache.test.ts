import { describe, expect, it } from "vitest";
import { createSharePasswordCache } from "./password-cache.ts";

function fakeClock(start = 0) {
  const state = { value: start };
  return { now: () => state.value, advance: (ms: number) => (state.value += ms) };
}

describe("createSharePasswordCache", () => {
  it("misses for a pair never set", () => {
    const cache = createSharePasswordCache();

    expect(cache.get("share1", "secret")).toBeUndefined();
  });

  it("hits with the exact verification result stored", () => {
    const cache = createSharePasswordCache();

    cache.set("share1", "secret", true);
    cache.set("share1", "wrong", false);

    expect(cache.get("share1", "secret")).toBe(true);
    expect(cache.get("share1", "wrong")).toBe(false);
  });

  it("never returns a failed verification as a success, even for the same share", () => {
    const cache = createSharePasswordCache();

    cache.set("share1", "wrong", false);

    expect(cache.get("share1", "wrong")).toBe(false);
    expect(cache.get("share1", "secret")).toBeUndefined();
  });

  it("expires an entry after ttlMs and re-probes on the next set", () => {
    const clock = fakeClock();
    const cache = createSharePasswordCache({ clock: clock.now, ttlMs: 60_000 });

    cache.set("share1", "secret", true);
    clock.advance(59_999);
    expect(cache.get("share1", "secret")).toBe(true);

    clock.advance(2);
    expect(cache.get("share1", "secret")).toBeUndefined();

    cache.set("share1", "secret", true);
    expect(cache.get("share1", "secret")).toBe(true);
  });

  it("evicts the oldest entry once maxEntries is reached", () => {
    const cache = createSharePasswordCache({ maxEntries: 2 });

    cache.set("share1", "a", true);
    cache.set("share2", "b", true);
    cache.set("share3", "c", true);

    expect(cache.get("share1", "a")).toBeUndefined();
    expect(cache.get("share2", "b")).toBe(true);
    expect(cache.get("share3", "c")).toBe(true);
  });

  it("refreshing an existing key does not count as a new entry toward the eviction bound", () => {
    const cache = createSharePasswordCache({ maxEntries: 2 });

    cache.set("share1", "a", true);
    cache.set("share2", "b", true);
    cache.set("share1", "a", false);

    expect(cache.get("share1", "a")).toBe(false);
    expect(cache.get("share2", "b")).toBe(true);
  });

  it("keeps a share id and password pair distinct from a different pair sharing a JSON-escaped boundary", () => {
    const cache = createSharePasswordCache();

    cache.set('share"1', "x", true);
    cache.set("share", '1","x', false);

    expect(cache.get('share"1', "x")).toBe(true);
    expect(cache.get("share", '1","x')).toBe(false);
  });

  it("defaults to Date.now when no clock is given", () => {
    const cache = createSharePasswordCache();

    cache.set("share1", "secret", true);

    expect(cache.get("share1", "secret")).toBe(true);
  });
});

it("invalidate forgets every entry of one share and leaves other shares alone", () => {
  const cache = createSharePasswordCache({ clock: () => 0, ttlMs: 60_000 });
  cache.set("share-a", "old", true);
  cache.set("share-a", "guess", false);
  cache.set("share-b", "old", true);
  cache.invalidate("share-a");
  expect(cache.get("share-a", "old")).toBeUndefined();
  expect(cache.get("share-a", "guess")).toBeUndefined();
  expect(cache.get("share-b", "old")).toBe(true);
  cache.invalidate("never-set");
  expect(cache.get("share-b", "old")).toBe(true);
});
