// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setListDesign, useListDesign } from "./use-list-design";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("updates every mounted consumer and follows other tabs", () => {
  const first = renderHook(useListDesign);
  const second = renderHook(useListDesign);
  expect(first.result.current[0]).toBe("classic");

  act(() => first.result.current[1]("beta"));
  expect(second.result.current[0]).toBe("beta");
  expect(localStorage.getItem("fdrive.list.design")).toBe('"beta"');

  act(() => {
    localStorage.setItem("fdrive.list.design", '"classic"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.list.design" }));
  });
  expect(first.result.current[0]).toBe("classic");
  act(() => setListDesign("beta"));
  expect(first.result.current[0]).toBe("beta");
});

it("renders the classic list on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [value] = useListDesign();
    return createElement("span", null, value);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>classic</span>");
});
