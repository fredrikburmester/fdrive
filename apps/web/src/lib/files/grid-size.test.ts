import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRID_SIZE,
  GRID_SIZE_STORAGE_KEY,
  GRID_SIZES,
  readGridSize,
  writeGridSize,
} from "./grid-size";
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

describe("grid size", () => {
  it("defaults to medium, the middle of the three sizes", () => {
    expect(readGridSize(memoryStorage())).toBe(DEFAULT_GRID_SIZE);
    expect(DEFAULT_GRID_SIZE).toBe("medium");
    expect(GRID_SIZES).toEqual(["small", "medium", "large"]);
  });

  it("round-trips a stored size and rejects unknown values", () => {
    const storage = memoryStorage();
    writeGridSize(storage, "large");
    expect(storage.data.get(GRID_SIZE_STORAGE_KEY)).toBe('"large"');
    expect(readGridSize(storage)).toBe("large");
    expect(readGridSize(memoryStorage({ [GRID_SIZE_STORAGE_KEY]: '"huge"' }))).toBe("medium");
  });
});
