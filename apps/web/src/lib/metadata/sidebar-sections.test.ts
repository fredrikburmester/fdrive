import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_SECTION_OPEN,
  readSidebarSectionOpen,
  sidebarSectionState,
  writeSidebarSectionOpen,
} from "./sidebar-sections";

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("readSidebarSectionOpen", () => {
  it("defaults to open when nothing is stored", () => {
    expect(readSidebarSectionOpen(fakeStorage(), "favorites")).toBe(DEFAULT_SIDEBAR_SECTION_OPEN);
  });

  it("reads a stored false value", () => {
    const storage = fakeStorage({ "fdrive.sidebar.section.tags": "false" });
    expect(readSidebarSectionOpen(storage, "tags")).toBe(false);
  });

  it("falls back to the default for malformed JSON", () => {
    const storage = fakeStorage({ "fdrive.sidebar.section.recents": "{not json" });
    expect(readSidebarSectionOpen(storage, "recents")).toBe(DEFAULT_SIDEBAR_SECTION_OPEN);
  });

  it("keys each section independently", () => {
    const storage = fakeStorage({ "fdrive.sidebar.section.favorites": "false" });
    expect(readSidebarSectionOpen(storage, "favorites")).toBe(false);
    expect(readSidebarSectionOpen(storage, "tags")).toBe(DEFAULT_SIDEBAR_SECTION_OPEN);
  });
});

describe("writeSidebarSectionOpen", () => {
  it("persists a value that readSidebarSectionOpen reads back", () => {
    const storage = fakeStorage();
    writeSidebarSectionOpen(storage, "recents", false);
    expect(readSidebarSectionOpen(storage, "recents")).toBe(false);
  });
});

describe("sidebarSectionState", () => {
  it("is loading while the query has not resolved", () => {
    expect(sidebarSectionState(undefined)).toBe("loading");
  });

  it("is empty for a resolved, empty list", () => {
    expect(sidebarSectionState([])).toBe("empty");
  });

  it("is content for a resolved, non-empty list", () => {
    expect(sidebarSectionState([{ id: "1" }])).toBe("content");
  });
});
