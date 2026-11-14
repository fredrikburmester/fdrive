// @vitest-environment jsdom
import type { SavedSearch } from "@fdrive/contracts";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSearchShortcut, SearchShortcutProvider, useSearchShortcut } from "./shortcut";

function SearchState() {
  const { open } = useSearchShortcut();
  return <span>{open ? "Open" : "Closed"}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("search shortcut ownership", () => {
  it("matches Cmd/Ctrl K case-insensitively, without matching unmodified or shifted keys", () => {
    const plain = { shiftKey: false };
    expect(isSearchShortcut({ key: "K", metaKey: true, ctrlKey: false, ...plain })).toBe(true);
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, ...plain })).toBe(true);
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: false, ...plain })).toBe(false);
    expect(isSearchShortcut({ key: "x", metaKey: true, ctrlKey: false, ...plain })).toBe(false);
    // Cmd+Shift+K toggles the chat panel, so search leaves it alone.
    expect(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, shiftKey: true })).toBe(
      false,
    );
  });

  it("owns shortcut state, toggles it, and removes its listener", () => {
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
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByText("Closed")).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("opens with a saved search until the panel closes or the shortcut reopens it", () => {
    const saved: SavedSearch = {
      id: "s1",
      name: "Invoices",
      query: "invoice",
      type: "any",
      folder: null,
    };
    function SavedState() {
      const { open, saved: current, setOpen, openSaved } = useSearchShortcut();
      return (
        <>
          <span>{`${open ? "Open" : "Closed"}:${current?.name ?? "none"}`}</span>
          <button type="button" onClick={() => openSaved(saved)}>
            Saved
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </>
      );
    }
    render(
      <SearchShortcutProvider>
        <SavedState />
      </SearchShortcutProvider>,
    );
    fireEvent.click(screen.getByText("Saved"));
    expect(screen.getByText("Open:Invoices")).toBeDefined();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.getByText("Closed:none")).toBeDefined();
    fireEvent.click(screen.getByText("Saved"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByText("Open:none")).toBeDefined();
  });

  it("requires the shell provider", () => {
    expect(() => renderHook(() => useSearchShortcut())).toThrow(
      "Search shortcuts require the shell provider.",
    );
  });
});
