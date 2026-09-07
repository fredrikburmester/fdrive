// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { isSearchShortcut, SearchShortcutProvider, useSearchShortcut } from "./shortcut";

function SearchState() {
  const { open } = useSearchShortcut();
  return <span>{open ? "Open" : "Closed"}</span>;
}

afterEach(() => {
  cleanup();
  accountTransition.finish(false);
  vi.restoreAllMocks();
});

describe("search shortcut ownership", () => {
  it("matches Cmd/Ctrl K case-insensitively, without matching unmodified keys", () => {
    expect(isSearchShortcut({ key: "K", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isSearchShortcut({ key: "x", metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("owns shortcut state, ignores pending changes, and removes its listener", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <SearchShortcutProvider>
        <SearchState />
      </SearchShortcutProvider>,
    );
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    expect(screen.getByText("Closed")).toBeDefined();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByText("Open")).toBeDefined();
    accountTransition.begin();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByText("Open")).toBeDefined();
    accountTransition.finish(false);
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByText("Closed")).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("requires the shell provider", () => {
    expect(() => renderHook(() => useSearchShortcut())).toThrow(
      "Search shortcuts require the shell provider.",
    );
  });
});
