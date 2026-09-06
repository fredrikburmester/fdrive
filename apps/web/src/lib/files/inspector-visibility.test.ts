import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSPECTOR_OPEN,
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
  it("defaults to closed", () => {
    expect(readInspectorOpen(memoryStorage())).toBe(DEFAULT_INSPECTOR_OPEN);
  });

  it("returns a previously stored open state", () => {
    const storage = memoryStorage({ "fdrive.inspector": JSON.stringify(true) });
    expect(readInspectorOpen(storage)).toBe(true);
  });

  it("falls back to default for a non-boolean value", () => {
    const storage = memoryStorage({ "fdrive.inspector": JSON.stringify("yes") });
    expect(readInspectorOpen(storage)).toBe(DEFAULT_INSPECTOR_OPEN);
  });
});

describe("writeInspectorOpen", () => {
  it("persists the state as JSON", () => {
    const storage = memoryStorage();
    writeInspectorOpen(storage, true);
    expect(storage.getItem("fdrive.inspector")).toBe(JSON.stringify(true));
  });
});
