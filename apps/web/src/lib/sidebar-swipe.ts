"use client";

import { useEffect } from "react";

/** A swipe that opens the sidebar starts this close to the screen's left edge, in pixels. */
export const SWIPE_EDGE = 24;

/** How far sideways a swipe goes before it opens or shuts the sidebar, in pixels. */
export const SWIPE_DISTANCE = 40;

/** Movement shorter than this says nothing yet about which way a touch is going. */
const SLOP = 10;

/** Fields a replayed tap focuses, since a click alone leaves them unfocused. */
const FIELDS = "input, textarea, select, [contenteditable=true]";

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
 * Clicks what a tap on the edge landed on. Taking the touch from the browser
 * also stops it from becoming a click, so the tap is played back here.
 */
function replayTap(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const field = target.closest(FIELDS);
  if (field instanceof HTMLElement) field.focus();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * On a phone, a swipe in from the screen's left edge opens the sidebar and a
 * swipe back to the left shuts it. A swipe that is mostly up or down is a
 * scroll, and one on a dialog, a menu or something that scrolls sideways
 * belongs to that.
 *
 * While the sidebar is shut, a touch on that edge is taken from the browser,
 * which keeps iOS from starting its swipe back to the previous page there. A
 * tap on the edge still clicks, but a scroll cannot start there. Android's
 * back swipe belongs to the system, which no page can take it from.
 */
export function useSidebarSwipe(on: boolean, open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!on) return;
    let start: { x: number; y: number } | null = null;
    // A touch on the shut sidebar's edge, taken from the browser: a tap until it moves.
    let held: EventTarget | null = null;

    function onStart(event: TouchEvent) {
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      start =
        touch && mayStart(touch.clientX, event.target, open)
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      held = null;
      if (start && !open) {
        event.preventDefault();
        held = event.target;
      }
    }

    function onMove(event: TouchEvent) {
      const touch = event.touches.item(0);
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.hypot(dx, dy) < SLOP) return;
      held = null;
      if (Math.abs(dy) > Math.abs(dx)) {
        start = null;
      } else if (open ? dx < -SWIPE_DISTANCE : dx > SWIPE_DISTANCE) {
        start = null;
        setOpen(!open);
      }
    }

    function onEnd() {
      if (held) replayTap(held);
      onCancel();
    }

    function onCancel() {
      start = null;
      held = null;
    }

    // Not passive: taking a touch from the browser needs preventDefault on its start.
    document.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [on, open, setOpen]);
}
