import { describe, expect, it } from "vitest";
import { computeGridLayout, readGridWidth, writeGridWidth } from "./grid-layout";
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

describe("computeGridLayout", () => {
  it("fits as many tiles as the container width allows", () => {
    // 4 tiles: 4 * 112 + 3 * 4 = 460 <= 500; a 5th would need 576.
    expect(computeGridLayout(500, 112, 4)).toEqual({ columns: 4, tileStride: 116 });
  });

  it("never returns fewer than one column, even for a zero container width", () => {
    expect(computeGridLayout(0, 112, 4).columns).toBe(1);
  });

  it("never returns fewer than one column when the container is narrower than one tile", () => {
    expect(computeGridLayout(50, 112, 4).columns).toBe(1);
  });

  it("returns one column with the stride itself when the tile stride is zero", () => {
    expect(computeGridLayout(500, 0, 0)).toEqual({ columns: 1, tileStride: 0 });
  });

  it("returns exactly one column when the container fits exactly one tile", () => {
    expect(computeGridLayout(112, 112, 4).columns).toBe(1);
  });

  it("fits a second column once the container is wide enough for the gap between them", () => {
    expect(computeGridLayout(112 * 2 + 4, 112, 4).columns).toBe(2);
  });
});

describe("readGridWidth", () => {
  it("returns 0 (unknown) when nothing is stored, distinguishing a cold start", () => {
    expect(readGridWidth(memoryStorage())).toBe(0);
  });

  it("returns 0 when the stored value is not a positive number", () => {
    expect(readGridWidth(memoryStorage({ "fdrive.gridWidth": JSON.stringify(-4) }))).toBe(0);
    expect(readGridWidth(memoryStorage({ "fdrive.gridWidth": JSON.stringify("700") }))).toBe(0);
    expect(readGridWidth(memoryStorage({ "fdrive.gridWidth": JSON.stringify(0) }))).toBe(0);
  });

  it("returns a previously persisted width, seeding the next mount's layout", () => {
    const storage = memoryStorage();
    writeGridWidth(storage, 640);
    const seeded = readGridWidth(storage);
    expect(seeded).toBe(640);
    expect(computeGridLayout(seeded, 112, 4).columns).toBeGreaterThan(1);
  });
});

describe("writeGridWidth", () => {
  it("persists the width under the shared fdrive.gridWidth key", () => {
    const storage = memoryStorage();
    writeGridWidth(storage, 812);
    expect(storage.getItem("fdrive.gridWidth")).toBe(JSON.stringify(812));
  });
});
