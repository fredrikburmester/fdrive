"use client";

import { useEffect } from "react";

/** A swipe that opens the sidebar starts this close to the screen's left edge, in pixels. */
export const SWIPE_EDGE = 24;

/** How far sideways a swipe goes before it opens or shuts the sidebar, in pixels. */
export const SWIPE_DISTANCE = 40;

/** Movement shorter than this says nothing yet about which way a touch is going. */
const SLOP = 10;

/**
 * Whether fdrive runs as an installed app. In a browser tab the screen's left
 * edge belongs to the browser's own back swipe.
 */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Whether a touch on `target` may be scrolling something sideways instead. */
export function scrollsSideways(target: EventTarget | null): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element;
    element = element.parentElement
  ) {
    const { overflowX } = getComputedStyle(element);
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      element.scrollWidth > element.clientWidth
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a touch that starts on `target`, `x` pixels from the left, may become a swipe. */
function mayStart(x: number, target: EventTarget | null, open: boolean): boolean {
  if (open) return true;
  return (
    x <= SWIPE_EDGE &&
    !(target instanceof Element && target.closest("[role=dialog], [role=menu]")) &&
    !scrollsSideways(target)
  );
}

/**
 * On a phone, in the installed app, a swipe in from the screen's left edge
 * opens the sidebar and a swipe back to the left shuts it. A swipe that is
 * mostly up or down is a scroll, and one on a dialog, a menu or something
 * that scrolls sideways belongs to that.
 */
export function useSidebarSwipe(on: boolean, open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!on || !isInstalledApp()) return;
    let start: { x: number; y: number } | null = null;

    function onStart(event: TouchEvent) {
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      start =
        touch && mayStart(touch.clientX, event.target, open)
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    }

    function onMove(event: TouchEvent) {
      const touch = event.touches.item(0);
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.hypot(dx, dy) < SLOP) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        start = null;
      } else if (open ? dx < -SWIPE_DISTANCE : dx > SWIPE_DISTANCE) {
        start = null;
        setOpen(!open);
      }
    }

    function onEnd() {
      start = null;
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [on, open, setOpen]);
}
