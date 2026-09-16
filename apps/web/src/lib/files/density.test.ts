import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_DENSITY,
  DENSITY_STORAGE_KEY,
  ROW_HEIGHTS,
  readListDensity,
  writeListDensity,
} from "./density";
import type { StorageLike } from "./storage";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("list density", () => {
  it("defaults to comfortable, which keeps the original row height", () => {
    expect(readListDensity(memoryStorage())).toBe(DEFAULT_LIST_DENSITY);
    expect(ROW_HEIGHTS[DEFAULT_LIST_DENSITY]).toBe(36);
    expect(ROW_HEIGHTS.compact).toBeLessThan(ROW_HEIGHTS.comfortable);
  });

  it("round-trips a stored density and rejects unknown values", () => {
    const storage = memoryStorage();
    writeListDensity(storage, "compact");
    expect(storage.data.get(DENSITY_STORAGE_KEY)).toBe('"compact"');
    expect(readListDensity(storage)).toBe("compact");
    expect(readListDensity(memoryStorage({ [DENSITY_STORAGE_KEY]: '"cozy"' }))).toBe("comfortable");
  });
});
