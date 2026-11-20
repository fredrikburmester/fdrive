import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_DENSITY,
  DENSITY_STORAGE_KEY,
  listRowHeight,
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
  it("defaults to comfortable, whose rows are about twice as tall as compact's", () => {
    expect(DEFAULT_LIST_DENSITY).toBe("comfortable");
    expect(readListDensity(memoryStorage())).toBe("comfortable");
    expect(ROW_HEIGHTS).toEqual({ comfortable: 64, compact: 36 });
  });

  it("round-trips a stored density and rejects unknown values", () => {
    const storage = memoryStorage();
    writeListDensity(storage, "compact");
    expect(storage.data.get(DENSITY_STORAGE_KEY)).toBe('"compact"');
    expect(readListDensity(storage)).toBe("compact");
    expect(readListDensity(memoryStorage({ [DENSITY_STORAGE_KEY]: '"cozy"' }))).toBe("comfortable");
  });

  it("gives phones taller two-line rows that never drop below a 44px tap target", () => {
    expect(listRowHeight("comfortable", false)).toBe(64);
    expect(listRowHeight("compact", false)).toBe(36);
    expect(listRowHeight("comfortable", true)).toBe(68);
    expect(listRowHeight("compact", true)).toBe(56);
    expect(listRowHeight("compact", true)).toBeGreaterThanOrEqual(44);
  });
});
