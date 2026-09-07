import { describe, expect, it } from "vitest";
import type { StorageLike } from "@/lib/files/storage";
import { IMAGE_MODE_STORAGE_KEY, readImageMode, writeImageMode } from "./image-mode";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("readImageMode", () => {
  it("defaults to false", () => {
    expect(readImageMode(memoryStorage())).toBe(false);
  });

  it("returns a previously stored true preference", () => {
    const storage = memoryStorage({ [IMAGE_MODE_STORAGE_KEY]: JSON.stringify(true) });
    expect(readImageMode(storage)).toBe(true);
  });

  it("falls back to default for an unrecognized value", () => {
    const storage = memoryStorage({ [IMAGE_MODE_STORAGE_KEY]: JSON.stringify("yes") });
    expect(readImageMode(storage)).toBe(false);
  });

  it("falls back to default for malformed JSON", () => {
    const storage = memoryStorage({ [IMAGE_MODE_STORAGE_KEY]: "{not json" });
    expect(readImageMode(storage)).toBe(false);
  });
});

describe("writeImageMode", () => {
  it("persists the preference as JSON and round-trips", () => {
    const storage = memoryStorage();
    writeImageMode(storage, true);
    expect(storage.getItem(IMAGE_MODE_STORAGE_KEY)).toBe(JSON.stringify(true));
    expect(readImageMode(storage)).toBe(true);
    writeImageMode(storage, false);
    expect(readImageMode(storage)).toBe(false);
  });
});
