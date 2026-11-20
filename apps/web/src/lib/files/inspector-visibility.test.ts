import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSPECTOR_OPEN,
  INSPECTOR_STORAGE_KEY,
  readInspectorOpen,
  writeInspectorOpen,
} from "./inspector-visibility";
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

describe("readInspectorOpen", () => {
  it("defaults to open", () => {
    expect(DEFAULT_INSPECTOR_OPEN).toBe(true);
    expect(readInspectorOpen(memoryStorage())).toBe(true);
  });

  it("returns a previously stored choice", () => {
    const storage = memoryStorage({ "fdrive.inspector.open": JSON.stringify(false) });
    expect(readInspectorOpen(storage)).toBe(false);
  });

  it("ignores a choice saved under the earlier key, when the panel started closed", () => {
    expect(INSPECTOR_STORAGE_KEY).toBe("fdrive.inspector.open");
    const storage = memoryStorage({ "fdrive.inspector": JSON.stringify(false) });
    expect(readInspectorOpen(storage)).toBe(true);
  });

  it("falls back to the default for a non-boolean value", () => {
    const storage = memoryStorage({ "fdrive.inspector.open": JSON.stringify("no") });
    expect(readInspectorOpen(storage)).toBe(DEFAULT_INSPECTOR_OPEN);
  });
});

describe("writeInspectorOpen", () => {
  it("persists the state as JSON, so a close sticks", () => {
    const storage = memoryStorage();
    writeInspectorOpen(storage, false);
    expect(storage.getItem("fdrive.inspector.open")).toBe(JSON.stringify(false));
    expect(readInspectorOpen(storage)).toBe(false);
  });
});
