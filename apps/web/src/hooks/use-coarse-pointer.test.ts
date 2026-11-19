// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCoarsePointer } from "./use-coarse-pointer";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("is false where the browser cannot answer, as on the server", () => {
  vi.stubGlobal("matchMedia", undefined);
  expect(renderHook(useCoarsePointer).result.current).toBe(false);
});

it("follows the pointer media query as it changes", () => {
  const listeners = new Set<() => void>();
  const query = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (text: string) => {
    expect(text).toBe("(pointer: coarse)");
    return query;
  });
  const { result, unmount } = renderHook(useCoarsePointer);
  expect(result.current).toBe(false);

  act(() => {
    query.matches = true;
    for (const listener of listeners) listener();
  });
  expect(result.current).toBe(true);
  unmount();
  expect(listeners.size).toBe(0);
});
