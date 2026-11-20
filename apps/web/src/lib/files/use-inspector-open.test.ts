// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setInspectorOpen, useInspectorOpen } from "./use-inspector-open";

const listeners = new Set<() => void>();
/** The side-panel media query: `matches` is whether the window is wide enough for one. */
const query = {
  matches: true,
  addEventListener: (_: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
};

function resize(wide: boolean) {
  act(() => {
    query.matches = wide;
    for (const listener of listeners) listener();
  });
}

beforeEach(() => {
  query.matches = true;
  vi.stubGlobal("matchMedia", (text: string) => {
    expect(text).toBe("(min-width: 1024px)");
    return query;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("opens the side panel by default, and a close sticks", () => {
  const first = renderHook(useInspectorOpen);
  expect(first.result.current[0]).toBe(true);

  act(() => first.result.current[1](false));
  expect(first.result.current[0]).toBe(false);
  expect(localStorage.getItem("fdrive.inspector.open")).toBe("false");

  first.unmount();
  expect(renderHook(useInspectorOpen).result.current[0]).toBe(false);
});

it("opens once for a browser that closed the panel under the earlier default", () => {
  localStorage.setItem("fdrive.inspector", "false");
  expect(renderHook(useInspectorOpen).result.current[0]).toBe(true);
});

it("never opens the sheet by itself, and keeps what a sheet does out of storage", () => {
  query.matches = false;
  const { result } = renderHook(useInspectorOpen);
  expect(result.current[0]).toBe(false);

  act(() => result.current[1](true));
  expect(result.current[0]).toBe(true);
  act(() => result.current[1](false));
  expect(result.current[0]).toBe(false);
  expect(localStorage.getItem("fdrive.inspector.open")).toBeNull();
});

it("keeps the sheet closed on load even when the side panel is stored open", () => {
  query.matches = false;
  localStorage.setItem("fdrive.inspector.open", "true");
  expect(renderHook(useInspectorOpen).result.current[0]).toBe(false);
});

it("closes when the window narrows rather than turning into a sheet, and returns when it widens", () => {
  const { result, unmount } = renderHook(useInspectorOpen);
  expect(result.current[0]).toBe(true);

  resize(false);
  expect(result.current[0]).toBe(false);
  // The sheet opens when asked for.
  act(() => result.current[1](true));
  expect(result.current[0]).toBe(true);

  resize(true);
  expect(result.current[0]).toBe(true);
  // The sheet that was left open does not come back with the next narrow window.
  resize(false);
  expect(result.current[0]).toBe(false);

  unmount();
  expect(listeners.size).toBe(0);
});

it("updates mounted consumers together and follows another tab", () => {
  const first = renderHook(useInspectorOpen);
  const second = renderHook(useInspectorOpen);

  act(() => setInspectorOpen(false));
  expect(first.result.current[0]).toBe(false);
  expect(second.result.current[0]).toBe(false);

  act(() => {
    localStorage.setItem("fdrive.inspector.open", "true");
    window.dispatchEvent(new StorageEvent("storage", { key: "fdrive.inspector.open" }));
  });
  expect(first.result.current[0]).toBe(true);
  expect(second.result.current[0]).toBe(true);
});

it("renders closed on the server, where neither the window nor storage exists", async () => {
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  function Probe() {
    const [open] = useInspectorOpen();
    return createElement("span", null, String(open));
  }
  expect(renderToString(createElement(Probe))).toBe("<span>false</span>");
});
