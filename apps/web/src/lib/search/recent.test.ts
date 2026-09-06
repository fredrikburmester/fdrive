import { describe, expect, it } from "vitest";
import type { StorageLike } from "./deps";
import { MAX_RECENT_ITEMS, pushRecent, RECENT_STORAGE_KEY, readRecent } from "./recent";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

const ITEM_A = { path: "/a.txt", name: "a.txt", openedAt: "2026-01-01T00:00:00.000Z" };
const ITEM_B = { path: "/b.txt", name: "b.txt", openedAt: "2026-01-02T00:00:00.000Z" };

describe("readRecent", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(readRecent(fakeStorage())).toEqual([]);
  });

  it("returns the stored list", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([ITEM_A, ITEM_B]) });
    expect(readRecent(storage)).toEqual([ITEM_A, ITEM_B]);
  });

  it("returns an empty array for malformed JSON", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: "not json" });
    expect(readRecent(storage)).toEqual([]);
  });

  it("returns an empty array when the stored value is not an item array", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([{ path: 1 }]) });
    expect(readRecent(storage)).toEqual([]);
  });

  it("returns an empty array when an array entry is not an object", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([5, "x", null]) });
    expect(readRecent(storage)).toEqual([]);
  });

  it("caps the result at MAX_RECENT_ITEMS", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      path: `/f${i}.txt`,
      name: `f${i}.txt`,
      openedAt: "2026-01-01T00:00:00.000Z",
    }));
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify(items) });
    expect(readRecent(storage)).toHaveLength(MAX_RECENT_ITEMS);
  });
});

describe("pushRecent", () => {
  it("adds an item to an empty list", () => {
    const storage = fakeStorage();
    const result = pushRecent(storage, ITEM_A);
    expect(result).toEqual([ITEM_A]);
    expect(readRecent(storage)).toEqual([ITEM_A]);
  });

  it("puts the newest item first", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([ITEM_A]) });
    const result = pushRecent(storage, ITEM_B);
    expect(result).toEqual([ITEM_B, ITEM_A]);
  });

  it("dedupes by path, moving the existing entry to the front", () => {
    const storage = fakeStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([ITEM_A, ITEM_B]) });
    const reopenedA = { ...ITEM_A, openedAt: "2026-02-01T00:00:00.000Z" };

    const result = pushRecent(storage, reopenedA);

    expect(result).toEqual([reopenedA, ITEM_B]);
  });

  it("caps the persisted list at MAX_RECENT_ITEMS", () => {
    const storage = fakeStorage();
    let result: ReturnType<typeof pushRecent> = [];
    for (let i = 0; i < MAX_RECENT_ITEMS + 3; i++) {
      result = pushRecent(storage, { path: `/f${i}.txt`, name: `f${i}.txt`, openedAt: "now" });
    }
    expect(result).toHaveLength(MAX_RECENT_ITEMS);
    expect(result[0]?.path).toBe(`/f${MAX_RECENT_ITEMS + 2}.txt`);
  });
});
