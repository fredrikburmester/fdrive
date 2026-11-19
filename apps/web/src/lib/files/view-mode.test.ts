import { describe, expect, it } from "vitest";
import type { StorageLike } from "./storage";
import { DEFAULT_VIEW_MODE, defaultViewModeFor, readViewMode, writeViewMode } from "./view-mode";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("readViewMode", () => {
  it("defaults to list", () => {
    expect(readViewMode(memoryStorage())).toBe(DEFAULT_VIEW_MODE);
  });

  it("returns a previously stored grid mode", () => {
    const storage = memoryStorage({ "fdrive.view": JSON.stringify("grid") });
    expect(readViewMode(storage)).toBe("grid");
  });

  it("returns a previously stored tree mode", () => {
    const storage = memoryStorage({ "fdrive.view": JSON.stringify("tree") });
    expect(readViewMode(storage)).toBe("tree");
  });

  it("falls back to default for an unrecognized value", () => {
    const storage = memoryStorage({ "fdrive.view": JSON.stringify("carousel") });
    expect(readViewMode(storage)).toBe(DEFAULT_VIEW_MODE);
  });
});

describe("writeViewMode", () => {
  it("persists the mode as JSON", () => {
    const storage = memoryStorage();
    writeViewMode(storage, "grid");
    expect(storage.getItem("fdrive.view")).toBe(JSON.stringify("grid"));
  });
});

describe("defaultViewModeFor", () => {
  it("starts the beta list as a tree and the classic list as a list", () => {
    expect(defaultViewModeFor("beta")).toBe("tree");
    expect(defaultViewModeFor("classic")).toBe("list");
  });

  it("is only the fallback, never over a stored mode", () => {
    const storage = memoryStorage({ "fdrive.view": JSON.stringify("grid") });
    expect(readViewMode(storage, defaultViewModeFor("beta"))).toBe("grid");
    expect(readViewMode(memoryStorage(), defaultViewModeFor("beta"))).toBe("tree");
  });
});
