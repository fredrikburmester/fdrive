// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setDefaultView, useDefaultView } from "./use-default-view";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("preserves the existing key and updates mounted consumers together", () => {
  localStorage.setItem("fdrive.view", '"tree"');
  const first = renderHook(useDefaultView);
  const second = renderHook(useDefaultView);
  expect(first.result.current[0]).toBe("tree");
  act(() => first.result.current[1]("grid"));
  expect(second.result.current[0]).toBe("grid");
  expect(localStorage.getItem("fdrive.view")).toBe('"grid"');
});

it("observes other-tab storage changes and handles missing or corrupt values", () => {
  const { result } = renderHook(useDefaultView);
  expect(result.current[0]).toBe("list");
  act(() => {
    localStorage.setItem("fdrive.view", '"grid"');
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.view" }));
  });
  expect(result.current[0]).toBe("grid");
  act(() => {
    localStorage.setItem("fdrive.view", '"invalid"');
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(result.current[0]).toBe("list");
  act(() => setDefaultView("tree"));
  expect(result.current[0]).toBe("tree");
});
