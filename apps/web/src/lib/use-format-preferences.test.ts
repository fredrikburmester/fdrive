// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setFormatPreference, useFormatPreferences, useFormatters } from "./use-format-preferences";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads stored keys, keeps a stable snapshot and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.format.sizes", '"decimal"');
  const first = renderHook(useFormatPreferences);
  const second = renderHook(useFormatPreferences);
  expect(first.result.current[0]).toEqual({ sizes: "decimal", dates: "relative", clock: "24h" });
  const before = first.result.current[0];
  first.rerender();
  expect(first.result.current[0]).toBe(before);
  act(() => first.result.current[1]("clock", "12h"));
  expect(second.result.current[0]).toEqual({ sizes: "decimal", dates: "relative", clock: "12h" });
  expect(localStorage.getItem("fdrive.format.clock")).toBe('"12h"');
});

it("observes other-tab changes and handles corrupt values", () => {
  const { result } = renderHook(useFormatPreferences);
  act(() => {
    localStorage.setItem("fdrive.format.dates", '"absolute"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.format.dates" }));
  });
  expect(result.current[0].dates).toBe("absolute");
  act(() => {
    localStorage.setItem("fdrive.format.dates", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0].dates).toBe("relative");
  act(() => setFormatPreference("sizes", "decimal"));
  expect(result.current[0].sizes).toBe("decimal");
});

it("binds the formatters to the current preferences", () => {
  const { result } = renderHook(useFormatters);
  expect(result.current.formatBytes(1536)).toBe("1.5 KB");
  expect(result.current.formatDate(new Date(2024, 0, 5, 9, 5))).toMatch(/^Jan 5(, 2024)?$/);
  act(() => {
    setFormatPreference("sizes", "decimal");
    setFormatPreference("dates", "absolute");
    setFormatPreference("clock", "12h");
  });
  expect(result.current.formatBytes(1500)).toBe("1.5 kB");
  expect(result.current.formatDate(new Date(2024, 0, 5, 9, 5))).toMatch(/^Jan 5(, 2024)? 9:05 AM$/);
});

it("renders the default on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [value] = useFormatPreferences();
    return createElement("span", null, `${value.sizes}:${value.dates}:${value.clock}`);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>binary:relative:24h</span>");
});
