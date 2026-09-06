import { describe, expect, it, vi } from "vitest";
import { readJson, type StorageLike, writeJson } from "./storage";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("readJson", () => {
  it("returns the fallback when the key is absent", () => {
    expect(readJson(memoryStorage(), "k", isString, "fallback")).toBe("fallback");
  });

  it("returns the parsed value when valid", () => {
    const storage = memoryStorage({ k: JSON.stringify("hello") });
    expect(readJson(storage, "k", isString, "fallback")).toBe("hello");
  });

  it("returns the fallback when the parsed value fails validation", () => {
    const storage = memoryStorage({ k: JSON.stringify(42) });
    expect(readJson(storage, "k", isString, "fallback")).toBe("fallback");
  });

  it("returns the fallback when the stored value is not valid JSON", () => {
    const storage = memoryStorage({ k: "not json" });
    expect(readJson(storage, "k", isString, "fallback")).toBe("fallback");
  });

  it("returns the fallback when storage.getItem throws", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => undefined,
    };
    expect(readJson(storage, "k", isString, "fallback")).toBe("fallback");
  });
});

describe("writeJson", () => {
  it("serializes the value into storage", () => {
    const storage = memoryStorage();
    writeJson(storage, "k", "hello");
    expect(storage.getItem("k")).toBe(JSON.stringify("hello"));
  });

  it("swallows errors from storage.setItem", () => {
    const setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    const storage: StorageLike = { getItem: () => null, setItem };
    expect(() => writeJson(storage, "k", "hello")).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});
