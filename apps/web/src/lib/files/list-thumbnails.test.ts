import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOW_THUMBNAILS,
  readShowThumbnails,
  SHOW_THUMBNAILS_STORAGE_KEY,
  writeShowThumbnails,
} from "./list-thumbnails";
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

describe("readShowThumbnails", () => {
  it("defaults to false when absent", () => {
    expect(readShowThumbnails(memoryStorage())).toBe(DEFAULT_SHOW_THUMBNAILS);
  });

  it("returns true when stored as true", () => {
    const storage = memoryStorage({
      [SHOW_THUMBNAILS_STORAGE_KEY]: JSON.stringify(true),
    });
    expect(readShowThumbnails(storage)).toBe(true);
  });

  it("returns false when stored as false", () => {
    const storage = memoryStorage({
      [SHOW_THUMBNAILS_STORAGE_KEY]: JSON.stringify(false),
    });
    expect(readShowThumbnails(storage)).toBe(false);
  });

  it("falls back to false for invalid stored value", () => {
    const storage = memoryStorage({
      [SHOW_THUMBNAILS_STORAGE_KEY]: JSON.stringify("yes"),
    });
    expect(readShowThumbnails(storage)).toBe(false);
  });
});

describe("writeShowThumbnails", () => {
  it("persists true to storage", () => {
    const storage = memoryStorage();
    writeShowThumbnails(storage, true);
    expect(storage.getItem(SHOW_THUMBNAILS_STORAGE_KEY)).toBe(JSON.stringify(true));
  });

  it("persists false to storage", () => {
    const storage = memoryStorage({
      [SHOW_THUMBNAILS_STORAGE_KEY]: JSON.stringify(true),
    });
    writeShowThumbnails(storage, false);
    expect(storage.getItem(SHOW_THUMBNAILS_STORAGE_KEY)).toBe(JSON.stringify(false));
  });
});
