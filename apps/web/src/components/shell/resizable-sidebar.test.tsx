// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/ui/sidebar";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from "@/lib/sidebar-width";

const mocks = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));

// jsdom has no pointer capture.
(Element.prototype as { setPointerCapture?: (id: number) => void }).setPointerCapture ??= () => {};

const { ResizableSidebarProvider, SidebarResizeHandle } = await import("./resizable-sidebar");

function renderSidebar() {
  const { container } = render(
    <ResizableSidebarProvider>
      <Sidebar>
        <SidebarResizeHandle />
      </Sidebar>
    </ResizableSidebarProvider>,
  );
  const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement;
  return {
    handle: screen.getByRole("separator", { name: "Resize sidebar" }),
    width: () => wrapper.style.getPropertyValue("--sidebar-width"),
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.mobile = false;
});

it("opens at the stored width and follows a drag within the bounds, remembering the result", () => {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "300");
  const { handle, width } = renderSidebar();
  expect(width()).toBe("300px");
  expect(handle.getAttribute("aria-valuenow")).toBe("300");

  // Moving without pressing does nothing.
  fireEvent.pointerMove(handle, { clientX: 400 });
  expect(width()).toBe("300px");

  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
  // The press must not start a native drag or a text selection underneath.
  expect(fireEvent.mouseDown(handle)).toBe(false);
  expect(handle.hasAttribute("data-snap-width")).toBe(true);
  fireEvent.pointerMove(handle, { clientX: 340 });
  expect(width()).toBe("340px");
  fireEvent.pointerMove(handle, { clientX: 2000 });
  expect(width()).toBe(`${MAX_SIDEBAR_WIDTH}px`);
  fireEvent.pointerMove(handle, { clientX: 0 });
  expect(width()).toBe(`${MIN_SIDEBAR_WIDTH}px`);
  fireEvent.pointerMove(handle, { clientX: 280 });
  fireEvent.pointerUp(handle, { clientX: 280, pointerId: 1 });

  fireEvent.pointerMove(handle, { clientX: 500 });
  expect(width()).toBe("280px");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("280");
});

it("snaps to the stored width on load, then lets the sidebar animate again", async () => {
  const { handle } = renderSidebar();
  expect(handle.hasAttribute("data-snap-width")).toBe(true);
  await waitFor(() => expect(handle.hasAttribute("data-snap-width")).toBe(false));

  fireEvent.pointerDown(handle, { clientX: 256, pointerId: 1 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(handle.hasAttribute("data-snap-width")).toBe(false);
});

it("resizes with the arrow keys and returns to the default on double-click", () => {
  const { handle, width } = renderSidebar();
  expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`);

  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH + 32}px`);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH + 16}px`);

  fireEvent.doubleClick(handle);
  expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`);
});

it("follows a width set in another tab", () => {
  const { width } = renderSidebar();
  act(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "420");
    window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY }));
  });
  expect(width()).toBe("420px");
});

it("has no handle on narrow screens, where the sidebar is a sheet", () => {
  mocks.mobile = true;
  render(
    <ResizableSidebarProvider>
      <SidebarResizeHandle />
    </ResizableSidebarProvider>,
  );
  expect(screen.queryByRole("separator")).toBeNull();
});
