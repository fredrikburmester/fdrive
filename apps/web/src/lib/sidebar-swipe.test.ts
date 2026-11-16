// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isInstalledApp, SWIPE_DISTANCE, SWIPE_EDGE, useSidebarSwipe } from "./sidebar-swipe";

let installed = true;

beforeEach(() => {
  installed = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: installed && query === "(display-mode: standalone)",
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "standalone");
  document.body.replaceChildren();
});

/** Dispatches a touch event with one touch per point, as `touches`. */
function touch(
  type: string,
  points: { x: number; y: number }[],
  target: EventTarget = document.body,
) {
  const event = new Event(type, { bubbles: true });
  const list = points.map(({ x, y }) => ({ clientX: x, clientY: y }));
  Object.defineProperty(event, "touches", {
    value: { length: list.length, item: (index: number) => list[index] ?? null },
  });
  target.dispatchEvent(event);
}

function swipe(from: { x: number; y: number }, to: { x: number; y: number }, target?: EventTarget) {
  touch("touchstart", [from], target);
  touch("touchmove", [to], target);
  touch("touchend", [], target);
}

function mount(open: boolean, on = true) {
  const setOpen = vi.fn();
  const hook = renderHook(() => useSidebarSwipe(on, open, setOpen));
  return { setOpen, hook };
}

it("opens the closed sidebar on a swipe in from the left edge", () => {
  const { setOpen } = mount(false);
  swipe({ x: SWIPE_EDGE, y: 300 }, { x: SWIPE_EDGE + SWIPE_DISTANCE + 1, y: 305 });
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it("shuts the open sidebar on a swipe to the left from anywhere", () => {
  const { setOpen } = mount(true);
  swipe({ x: 200, y: 300 }, { x: 200 - SWIPE_DISTANCE - 1, y: 300 });
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(false);
});

it("waits through a short wobble, then counts the swipe once it goes far enough", () => {
  const { setOpen } = mount(false);
  touch("touchstart", [{ x: 4, y: 300 }]);
  touch("touchmove", [{ x: 9, y: 302 }]);
  touch("touchmove", [{ x: 30, y: 302 }]);
  expect(setOpen).not.toHaveBeenCalled();
  touch("touchmove", [{ x: 4 + SWIPE_DISTANCE + 1, y: 302 }]);
  // Counted once: the rest of the same swipe does nothing more.
  touch("touchmove", [{ x: 200, y: 302 }]);
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it("leaves a swipe that starts away from the edge, or with two fingers, alone", () => {
  const { setOpen } = mount(false);
  swipe({ x: SWIPE_EDGE + 1, y: 300 }, { x: 200, y: 300 });
  touch("touchstart", [
    { x: 4, y: 300 },
    { x: 60, y: 300 },
  ]);
  touch("touchmove", [{ x: 200, y: 300 }]);
  expect(setOpen).not.toHaveBeenCalled();
});

it("treats a mostly vertical move as a scroll, for the rest of that touch", () => {
  const { setOpen } = mount(false);
  touch("touchstart", [{ x: 4, y: 300 }]);
  touch("touchmove", [{ x: 20, y: 360 }]);
  touch("touchmove", [{ x: 200, y: 360 }]);
  expect(setOpen).not.toHaveBeenCalled();
});

it("ignores moves after the touch ends, and moves with no touch left", () => {
  const { setOpen } = mount(false);
  touch("touchstart", [{ x: 4, y: 300 }]);
  touch("touchmove", []);
  touch("touchcancel", []);
  touch("touchmove", [{ x: 200, y: 300 }]);
  expect(setOpen).not.toHaveBeenCalled();
});

it("leaves a swipe on a dialog, a menu or a sideways scroller to that", () => {
  const { setOpen } = mount(false);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const scroller = document.createElement("div");
  scroller.style.overflowX = "auto";
  Object.defineProperty(scroller, "scrollWidth", { value: 800 });
  Object.defineProperty(scroller, "clientWidth", { value: 300 });
  const row = document.createElement("span");
  scroller.append(row);
  document.body.append(dialog, menu, scroller);

  for (const target of [dialog, menu, row]) {
    swipe({ x: 4, y: 300 }, { x: 200, y: 300 }, target);
  }
  expect(setOpen).not.toHaveBeenCalled();
});

it("still opens from an overflowing element that has nothing to scroll sideways", () => {
  const { setOpen } = mount(false);
  const wide = document.createElement("div");
  wide.style.overflowX = "scroll";
  document.body.append(wide);
  swipe({ x: 4, y: 300 }, { x: 200, y: 300 }, wide);
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it("opens from a touch aimed at the document itself", () => {
  const { setOpen } = mount(false);
  swipe({ x: 4, y: 300 }, { x: 200, y: 300 }, document);
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it("does nothing when off, in a browser tab, or once unmounted", () => {
  const off = mount(false, false);
  swipe({ x: 4, y: 300 }, { x: 200, y: 300 });
  expect(off.setOpen).not.toHaveBeenCalled();

  installed = false;
  const tab = mount(false);
  swipe({ x: 4, y: 300 }, { x: 200, y: 300 });
  expect(tab.setOpen).not.toHaveBeenCalled();

  installed = true;
  const gone = mount(false);
  gone.hook.unmount();
  swipe({ x: 4, y: 300 }, { x: 200, y: 300 });
  expect(gone.setOpen).not.toHaveBeenCalled();
});

it("knows the installed app on iOS, where only navigator.standalone says so", () => {
  installed = false;
  expect(isInstalledApp()).toBe(false);
  Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
  expect(isInstalledApp()).toBe(true);
});
