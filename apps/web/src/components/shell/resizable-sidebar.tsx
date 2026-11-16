"use client";

import { cn } from "cn";
import type { ComponentProps, CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useSidebarWidth,
} from "@/lib/sidebar-width";

const KEYBOARD_STEP = 16;

/** `SidebarProvider` at the width this browser last gave the sidebar. */
export function ResizableSidebarProvider({
  className,
  style,
  ...props
}: ComponentProps<typeof SidebarProvider>) {
  const [width] = useSidebarWidth();

  return (
    <SidebarProvider
      className={cn(
        // The sidebar animates its width for collapsing; while the handle asks, it follows at once.
        "[&:has([data-snap-width])_[data-slot=sidebar-container]]:transition-none [&:has([data-snap-width])_[data-slot=sidebar-gap]]:transition-none",
        className,
      )}
      style={{ "--sidebar-width": `${width}px`, ...style } as CSSProperties}
      {...props}
    />
  );
}

/**
 * The drag handle on the sidebar's inner edge: drag or use the arrow keys to
 * resize, double-click to return to the default width. An invisible strip
 * across the edge that shows a thin line on hover, and while dragged marks
 * `<html data-resizing>` so the resize cursor holds over the whole page.
 * Rendered inside `Sidebar`, on desktop only.
 */
export function SidebarResizeHandle() {
  const { isMobile } = useSidebar();
  const [width, setWidth] = useSidebarWidth();
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);
  // The stored width only arrives with hydration, so the first frame snaps to it instead of sliding.
  const [restoring, setRestoring] = useState(true);
  const dragging = drag !== null;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setRestoring(false));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.dataset.resizing = "";
    return () => {
      delete root.dataset.resizing;
    };
  }, [dragging]);

  if (isMobile) return null;

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    setDrag({ startX: event.clientX, startWidth: width });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag === null) return;
    setWidth(drag.startWidth + (event.clientX - drag.startX));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be dragged; this is a resize handle with the separator role WAI-ARIA gives it.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      data-snap-width={dragging || restoring || undefined}
      className={cn(
        "absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none group-data-[collapsible=offcanvas]:hidden after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-sidebar-border focus-visible:outline-none focus-visible:after:bg-sidebar-ring",
        dragging && "after:bg-sidebar-ring hover:after:bg-sidebar-ring",
      )}
      // Once the edge moves, the press point lies over the sidebar's links; without this the browser drags one.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={() => setWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") setWidth(width + KEYBOARD_STEP);
        else if (event.key === "ArrowLeft") setWidth(width - KEYBOARD_STEP);
      }}
    />
  );
}
