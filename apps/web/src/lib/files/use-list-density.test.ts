// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setListDensity, useListDensity } from "./use-list-density";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads the stored key and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.list.density", '"compact"');
  const first = renderHook(useListDensity);
  const second = renderHook(useListDensity);
  expect(first.result.current[0]).toBe("compact");
  act(() => first.result.current[1]("comfortable"));
  expect(second.result.current[0]).toBe("comfortable");
  expect(localStorage.getItem("fdrive.list.density")).toBe('"comfortable"');
});

it("observes other-tab storage changes and handles corrupt values", () => {
  const { result } = renderHook(useListDensity);
  expect(result.current[0]).toBe("comfortable");
  act(() => {
    localStorage.setItem("fdrive.list.density", '"compact"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.list.density" }));
  });
  expect(result.current[0]).toBe("compact");
  act(() => {
    localStorage.setItem("fdrive.list.density", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0]).toBe("comfortable");
  act(() => setListDensity("compact"));
  expect(result.current[0]).toBe("compact");
});

it("renders the default on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [value] = useListDensity();
    return createElement("span", null, value);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>comfortable</span>");
});
