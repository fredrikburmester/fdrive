// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  readSidebarWidth,
  SIDEBAR_WIDTH_KEY,
  setSidebarWidth,
  useSidebarWidth,
} from "./sidebar-width";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads the stored width within bounds, tolerating corrupt or blocked storage", () => {
  expect(readSidebarWidth(localStorage)).toBe(DEFAULT_SIDEBAR_WIDTH);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "320");
  expect(readSidebarWidth(localStorage)).toBe(320);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "9999");
  expect(readSidebarWidth(localStorage)).toBe(MAX_SIDEBAR_WIDTH);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "1");
  expect(readSidebarWidth(localStorage)).toBe(MIN_SIDEBAR_WIDTH);
  for (const corrupt of ['"wide"', "null", "{bad"]) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, corrupt);
    expect(readSidebarWidth(localStorage)).toBe(DEFAULT_SIDEBAR_WIDTH);
  }
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  expect(readSidebarWidth(blocked)).toBe(DEFAULT_SIDEBAR_WIDTH);
  expect(clampSidebarWidth(300.6)).toBe(301);
});

it("updates every mounted consumer and other tabs together", () => {
  const first = renderHook(useSidebarWidth);
  const second = renderHook(useSidebarWidth);
  expect(first.result.current[0]).toBe(DEFAULT_SIDEBAR_WIDTH);

  act(() => first.result.current[1](9999));
  expect(second.result.current[0]).toBe(MAX_SIDEBAR_WIDTH);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(MAX_SIDEBAR_WIDTH));

  act(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "300");
    window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY }));
  });
  expect(first.result.current[0]).toBe(300);
});

it("survives a storage that refuses writes", () => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error("quota");
  };
  try {
    expect(() => setSidebarWidth(300)).not.toThrow();
  } finally {
    Storage.prototype.setItem = setItem;
  }
});

it("renders the default on the server", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [width] = useSidebarWidth();
    return createElement("span", null, width);
  }
  expect(renderToString(createElement(Probe))).toBe(`<span>${DEFAULT_SIDEBAR_WIDTH}</span>`);
});
