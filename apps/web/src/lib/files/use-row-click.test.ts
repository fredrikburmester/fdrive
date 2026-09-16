// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setRowClickAction, useRowClickAction } from "./use-row-click";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads the stored key and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.list.rowClick", '"open"');
  const first = renderHook(useRowClickAction);
  const second = renderHook(useRowClickAction);
  expect(first.result.current[0]).toBe("open");
  act(() => first.result.current[1]("toggle"));
  expect(second.result.current[0]).toBe("toggle");
  expect(localStorage.getItem("fdrive.list.rowClick")).toBe('"toggle"');
});

it("observes other-tab storage changes and handles missing or corrupt values", () => {
  const { result } = renderHook(useRowClickAction);
  expect(result.current[0]).toBe("select");
  act(() => {
    localStorage.setItem("fdrive.list.rowClick", '"open"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.list.rowClick" }));
  });
  expect(result.current[0]).toBe("open");
  act(() => {
    localStorage.setItem("fdrive.list.rowClick", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0]).toBe("select");
  act(() => setRowClickAction("toggle"));
  expect(result.current[0]).toBe("toggle");
});

it("renders the default on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [action] = useRowClickAction();
    return createElement("span", null, action);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>select</span>");
});
