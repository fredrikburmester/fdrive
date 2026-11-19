import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_DESIGN,
  LIST_DESIGN_STORAGE_KEY,
  readListDesign,
  writeListDesign,
} from "./list-design";
import type { StorageLike } from "./storage";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("readListDesign", () => {
  it("defaults to the classic list", () => {
    expect(DEFAULT_LIST_DESIGN).toBe("classic");
    expect(readListDesign(memoryStorage())).toBe("classic");
  });

  it("reads the beta once chosen, and ignores anything else", () => {
    expect(readListDesign(memoryStorage({ [LIST_DESIGN_STORAGE_KEY]: '"beta"' }))).toBe("beta");
    expect(readListDesign(memoryStorage({ [LIST_DESIGN_STORAGE_KEY]: '"neon"' }))).toBe("classic");
  });
});

describe("writeListDesign", () => {
  it("persists the design as JSON", () => {
    const storage = memoryStorage();
    writeListDesign(storage, "beta");
    expect(storage.getItem(LIST_DESIGN_STORAGE_KEY)).toBe('"beta"');
  });
});
