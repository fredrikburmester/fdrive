// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setGridSize, useGridSize } from "./use-grid-size";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reads the stored key and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.grid.size", '"small"');
  const first = renderHook(useGridSize);
  const second = renderHook(useGridSize);
  expect(first.result.current[0]).toBe("small");
  act(() => first.result.current[1]("large"));
  expect(second.result.current[0]).toBe("large");
  expect(localStorage.getItem("fdrive.grid.size")).toBe('"large"');
});

it("observes other-tab storage changes and handles corrupt values", () => {
  const { result } = renderHook(useGridSize);
  expect(result.current[0]).toBe("medium");
  act(() => {
    localStorage.setItem("fdrive.grid.size", '"large"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.grid.size" }));
  });
  expect(result.current[0]).toBe("large");
  act(() => {
    localStorage.setItem("fdrive.grid.size", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0]).toBe("medium");
  act(() => setGridSize("small"));
  expect(result.current[0]).toBe("small");
});

it("renders the default on the server, where storage does not exist", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [value] = useGridSize();
    return createElement("span", null, value);
  }
  expect(renderToString(createElement(Probe))).toBe("<span>medium</span>");
});
