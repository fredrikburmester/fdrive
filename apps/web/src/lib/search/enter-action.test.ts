import { describe, expect, it } from "vitest";
import type { StorageLike } from "@/lib/files/storage";
import {
  DEFAULT_ENTER_ACTION,
  ENTER_ACTION_STORAGE_KEY,
  readEnterAction,
  writeEnterAction,
} from "./enter-action";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("readEnterAction", () => {
  it("defaults to file", () => {
    expect(readEnterAction(memoryStorage())).toBe("file");
    expect(DEFAULT_ENTER_ACTION).toBe("file");
  });

  it("returns a previously stored folder preference", () => {
    const storage = memoryStorage({ [ENTER_ACTION_STORAGE_KEY]: JSON.stringify("folder") });
    expect(readEnterAction(storage)).toBe("folder");
  });

  it("falls back to default for an unrecognized value", () => {
    const storage = memoryStorage({ [ENTER_ACTION_STORAGE_KEY]: JSON.stringify("carousel") });
    expect(readEnterAction(storage)).toBe(DEFAULT_ENTER_ACTION);
  });

  it("falls back to default for malformed JSON", () => {
    const storage = memoryStorage({ [ENTER_ACTION_STORAGE_KEY]: "{not json" });
    expect(readEnterAction(storage)).toBe(DEFAULT_ENTER_ACTION);
  });
});

describe("writeEnterAction", () => {
  it("persists the preference as JSON", () => {
    const storage = memoryStorage();
    writeEnterAction(storage, "folder");
    expect(storage.getItem(ENTER_ACTION_STORAGE_KEY)).toBe(JSON.stringify("folder"));
  });

  it("round-trips through readEnterAction", () => {
    const storage = memoryStorage();
    writeEnterAction(storage, "folder");
    expect(readEnterAction(storage)).toBe("folder");
    writeEnterAction(storage, "file");
    expect(readEnterAction(storage)).toBe("file");
  });
});
