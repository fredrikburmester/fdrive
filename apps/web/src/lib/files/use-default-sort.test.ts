// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setDefaultSort, useDefaultSort } from "./use-default-sort";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads the existing sort key and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.sort", JSON.stringify({ key: "size", direction: "desc" }));
  const first = renderHook(useDefaultSort);
  const second = renderHook(useDefaultSort);
  expect(first.result.current[0]).toEqual({ key: "size", direction: "desc" });
  act(() => first.result.current[1]({ key: "ext", direction: "asc" }));
  expect(second.result.current[0]).toEqual({ key: "ext", direction: "asc" });
  expect(JSON.parse(localStorage.getItem("fdrive.sort") ?? "")).toEqual({
    key: "ext",
    direction: "asc",
  });
});

it("keeps a stable snapshot, observes other-tab changes and handles corrupt values", () => {
  const { result, rerender } = renderHook(useDefaultSort);
  expect(result.current[0]).toEqual({ key: "name", direction: "asc" });
  const before = result.current[0];
  rerender();
  expect(result.current[0]).toBe(before);
  act(() => {
    localStorage.setItem("fdrive.sort", JSON.stringify({ key: "modifiedAt", direction: "desc" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.sort" }));
  });
  expect(result.current[0]).toEqual({ key: "modifiedAt", direction: "desc" });
  act(() => {
    localStorage.setItem("fdrive.sort", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0]).toEqual({ key: "name", direction: "asc" });
  act(() => setDefaultSort({ key: "size", direction: "asc" }));
  expect(result.current[0]).toEqual({ key: "size", direction: "asc" });
});

it("renders the default on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [value] = useDefaultSort();
    return createElement("span", null, `${value.key}:${value.direction}`);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>name:asc</span>");
});
