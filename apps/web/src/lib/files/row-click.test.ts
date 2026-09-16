import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROW_CLICK_ACTION,
  ROW_CLICK_STORAGE_KEY,
  readRowClickAction,
  resolveRowClick,
  writeRowClickAction,
} from "./row-click";
import type { StorageLike } from "./storage";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("readRowClickAction", () => {
  it("defaults to select when nothing is stored", () => {
    expect(readRowClickAction(memoryStorage())).toBe(DEFAULT_ROW_CLICK_ACTION);
    expect(DEFAULT_ROW_CLICK_ACTION).toBe("select");
  });

  it("reads each valid stored action", () => {
    for (const action of ["select", "toggle", "open"] as const) {
      const storage = memoryStorage({ [ROW_CLICK_STORAGE_KEY]: JSON.stringify(action) });
      expect(readRowClickAction(storage)).toBe(action);
    }
  });

  it("falls back to select for unknown or malformed values", () => {
    expect(readRowClickAction(memoryStorage({ [ROW_CLICK_STORAGE_KEY]: '"double"' }))).toBe(
      "select",
    );
    expect(readRowClickAction(memoryStorage({ [ROW_CLICK_STORAGE_KEY]: "not json" }))).toBe(
      "select",
    );
  });
});

describe("writeRowClickAction", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    writeRowClickAction(storage, "open");
    expect(storage.data.get(ROW_CLICK_STORAGE_KEY)).toBe('"open"');
    expect(readRowClickAction(storage)).toBe("open");
  });
});

describe("resolveRowClick", () => {
  const plain = { shift: false, meta: false };

  it("keeps a plain click as a plain selection in select mode", () => {
    expect(resolveRowClick("select", plain)).toEqual({ kind: "select", modifiers: plain });
  });

  it("turns a plain click into a toggle in toggle mode", () => {
    expect(resolveRowClick("toggle", plain)).toEqual({
      kind: "select",
      modifiers: { shift: false, meta: true },
    });
  });

  it("opens on a plain click in open mode", () => {
    expect(resolveRowClick("open", plain)).toEqual({ kind: "open" });
  });

  it("passes modified clicks through unchanged in every mode", () => {
    const shift = { shift: true, meta: false };
    const meta = { shift: false, meta: true };
    for (const action of ["select", "toggle", "open"] as const) {
      expect(resolveRowClick(action, shift)).toEqual({ kind: "select", modifiers: shift });
      expect(resolveRowClick(action, meta)).toEqual({ kind: "select", modifiers: meta });
    }
  });
});
