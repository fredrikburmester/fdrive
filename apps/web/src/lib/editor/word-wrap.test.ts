import { describe, expect, it } from "vitest";
import { readWordWrap, type StorageLike, writeWordWrap } from "./word-wrap";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error("disabled");
    },
    setItem: () => {
      throw new Error("disabled");
    },
  };
}

describe("readWordWrap", () => {
  it("defaults to false when nothing is stored", () => {
    expect(readWordWrap(memoryStorage())).toBe(false);
  });

  it("reads a stored true value", () => {
    expect(readWordWrap(memoryStorage({ "fdrive.editor.wordWrap": "true" }))).toBe(true);
  });

  it("reads a stored false value", () => {
    expect(readWordWrap(memoryStorage({ "fdrive.editor.wordWrap": "false" }))).toBe(false);
  });

  it("falls back to the default for a garbled value", () => {
    expect(readWordWrap(memoryStorage({ "fdrive.editor.wordWrap": "nonsense" }))).toBe(false);
  });

  it("falls back to the default when storage throws", () => {
    expect(readWordWrap(throwingStorage())).toBe(false);
  });
});

describe("writeWordWrap", () => {
  it("persists true", () => {
    const storage = memoryStorage();
    writeWordWrap(storage, true);
    expect(readWordWrap(storage)).toBe(true);
  });

  it("persists false", () => {
    const storage = memoryStorage({ "fdrive.editor.wordWrap": "true" });
    writeWordWrap(storage, false);
    expect(readWordWrap(storage)).toBe(false);
  });

  it("swallows a storage error", () => {
    expect(() => writeWordWrap(throwingStorage(), true)).not.toThrow();
  });
});
