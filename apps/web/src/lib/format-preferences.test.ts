import { describe, expect, it } from "vitest";
import type { StorageLike } from "@/lib/files/storage";
import {
  DEFAULT_FORMAT_PREFERENCES,
  FORMAT_STORAGE_KEYS,
  readFormatPreferences,
  writeFormatPreference,
} from "./format-preferences";

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

describe("format preferences", () => {
  it("defaults every key to the original rendering", () => {
    expect(readFormatPreferences(memoryStorage())).toEqual(DEFAULT_FORMAT_PREFERENCES);
    expect(DEFAULT_FORMAT_PREFERENCES).toEqual({
      sizes: "binary",
      dates: "relative",
      clock: "24h",
    });
  });

  it("reads each key independently and ignores unknown values per key", () => {
    const storage = memoryStorage({
      [FORMAT_STORAGE_KEYS.sizes]: '"decimal"',
      [FORMAT_STORAGE_KEYS.dates]: '"fuzzy"',
      [FORMAT_STORAGE_KEYS.clock]: '"12h"',
    });
    expect(readFormatPreferences(storage)).toEqual({
      sizes: "decimal",
      dates: "relative",
      clock: "12h",
    });
  });

  it("writes one key without touching the others", () => {
    const storage = memoryStorage({ [FORMAT_STORAGE_KEYS.clock]: '"12h"' });
    writeFormatPreference(storage, "dates", "absolute");
    expect(storage.data.get(FORMAT_STORAGE_KEYS.dates)).toBe('"absolute"');
    expect(readFormatPreferences(storage)).toEqual({
      sizes: "binary",
      dates: "absolute",
      clock: "12h",
    });
  });
});
