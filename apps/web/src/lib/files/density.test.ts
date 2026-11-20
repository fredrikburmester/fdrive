import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_DENSITY,
  DENSITY_STORAGE_KEY,
  LIST_DENSITIES,
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
  it("defaults to standard, between roomy comfortable rows and tight compact ones", () => {
    expect(DEFAULT_LIST_DENSITY).toBe("standard");
    expect(readListDensity(memoryStorage())).toBe("standard");
    expect(ROW_HEIGHTS).toEqual({ comfortable: 64, standard: 36, compact: 30 });
    expect(LIST_DENSITIES).toEqual(["comfortable", "standard", "compact"]);
  });

  it("ignores a choice saved under the earlier key, whose compact meant standard", () => {
    expect(DENSITY_STORAGE_KEY).toBe("fdrive.list.rowDensity");
    expect(readListDensity(memoryStorage({ "fdrive.list.density": '"compact"' }))).toBe("standard");
  });

  it("round-trips a stored density and rejects unknown values", () => {
    const storage = memoryStorage();
    for (const density of LIST_DENSITIES) {
      writeListDensity(storage, density);
      expect(storage.data.get(DENSITY_STORAGE_KEY)).toBe(JSON.stringify(density));
      expect(readListDensity(storage)).toBe(density);
    }
    expect(readListDensity(memoryStorage({ [DENSITY_STORAGE_KEY]: '"cozy"' }))).toBe("standard");
  });

  it("gives phones taller two-line rows that never drop below a 44px tap target", () => {
    expect(listRowHeight("comfortable", false)).toBe(64);
    expect(listRowHeight("standard", false)).toBe(36);
    expect(listRowHeight("compact", false)).toBe(30);
    expect(listRowHeight("comfortable", true)).toBe(68);
    expect(listRowHeight("standard", true)).toBe(56);
    expect(listRowHeight("compact", true)).toBe(48);
    expect(listRowHeight("compact", true)).toBeGreaterThanOrEqual(44);
  });
});
