import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await delay(ms);
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("never runs more than the given concurrency at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    const items = [1, 2, 3, 4, 5];
    await mapWithConcurrency(items, 2, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("clamps concurrency to at least 1 and at most the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 0, async (item) => item);
    expect(results).toEqual([1, 2]);

    const results2 = await mapWithConcurrency([1, 2], 100, async (item) => item);
    expect(results2).toEqual([1, 2]);
  });

  it("resolves to an empty array for an empty input", async () => {
    const results = await mapWithConcurrency<number, number>([], 4, async (item) => item);
    expect(results).toEqual([]);
  });

  it("propagates a rejection from fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
