import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoScrollSpeed,
  isMarqueeStartTarget,
  itemsInRect,
  type LayoutItem,
  type MarqueeMode,
  marqueeSelection,
  type Point,
  passesDragThreshold,
  rectFromPoints,
} from "@/lib/files/marquee";

export interface UseMarqueeSelectionOptions {
  /** The scrollable element the marquee draws inside of and auto-scrolls. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The current layout of every known entry, for hit testing. Called fresh
   * on every frame of the drag, so it should be cheap (derived from the
   * virtualizer's state, not a DOM query). */
  getLayout: () => readonly LayoutItem[];
  /** The selection in effect when a drag starts: the base for a Cmd/Ctrl or
   * Shift drag's union, and what Escape restores. */
  getSelected: () => readonly string[];
  /** Applies a full selection, replacing whatever was selected before. */
  onChangeSelection: (paths: string[]) => void;
  /** Clears the selection, for a plain click on empty listing space. */
  onClearSelection: () => void;
}

export interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface DragSession {
  readonly pointerId: number;
  readonly startContent: Point;
  readonly startClient: Point;
  readonly baseSelected: readonly string[];
  readonly mode: MarqueeMode;
  dragging: boolean;
  latestClient: Point;
}

/**
 * Drives Finder-style rubber-band (marquee) selection over a virtualized
 * listing. A pointerdown on empty space (per `isMarqueeStartTarget`) starts
 * tracking; a 4px move turns it into a visible drag; while dragging, the
 * rectangle (in the scroll container's content coordinate space, so it
 * stays correct across scrolling) is hit-tested against `getLayout()` every
 * animation frame, and the resulting paths replace or add to the selection
 * depending on the modifier keys held at drag start. The pointer
 * auto-scrolls the container near its top/bottom edge. Escape cancels and
 * restores the selection captured when the drag began. A plain click (no
 * movement past the threshold) on empty space clears the selection instead.
 *
 * Uses pointer capture on `containerRef`'s element, which the UI Events
 * spec also retargets the resulting `click` event to; combined with
 * `isMarqueeStartTarget`, that is what tells a real background click apart
 * from a click that happened to land on a row or tile's own content.
 *
 * All listening happens through native `addEventListener` calls on the
 * container element itself, not JSX event props: a portaled overlay
 * (a context menu, a dialog) is a React-tree descendant of this listing
 * even though it renders outside the container in the real DOM, and React's
 * synthetic events still bubble through the React tree across that portal
 * boundary. A JSX `onPointerDown`/`onClick` prop here would misfire for
 * clicks on that unrelated, portaled content; a native listener only ever
 * fires for events whose real DOM target is actually inside the container.
 */
export function useMarqueeSelection({
  containerRef,
  getLayout,
  getSelected,
  onChangeSelection,
  onClearSelection,
}: UseMarqueeSelectionOptions): {
  rect: MarqueeRect | null;
} {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const rafRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const getLayoutRef = useRef(getLayout);
  getLayoutRef.current = getLayout;
  const getSelectedRef = useRef(getSelected);
  getSelectedRef.current = getSelected;
  const onChangeSelectionRef = useRef(onChangeSelection);
  onChangeSelectionRef.current = onChangeSelection;
  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;

  const tick = useCallback(() => {
    const container = containerRef.current;
    const session = sessionRef.current;
    if (container === null || session === null || !session.dragging) {
      rafRef.current = null;
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const contentPoint: Point = {
      x: session.latestClient.x - containerRect.left + container.scrollLeft,
      y: session.latestClient.y - containerRect.top + container.scrollTop,
    };
    const rectContent = rectFromPoints(session.startContent, contentPoint);
    setRect({
      left: rectContent.left,
      top: rectContent.top,
      width: rectContent.right - rectContent.left,
      height: rectContent.bottom - rectContent.top,
    });

    const covered = itemsInRect(rectContent, getLayoutRef.current());
    onChangeSelectionRef.current(marqueeSelection(session.baseSelected, covered, session.mode));

    const speed = autoScrollSpeed(session.latestClient.y, containerRect.top, containerRect.height);
    if (speed !== 0) {
      container.scrollTop += speed;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [containerRef]);

  const stop = useCallback(
    (restore: boolean) => {
      const session = sessionRef.current;
      const container = containerRef.current;
      if (session && container?.hasPointerCapture(session.pointerId)) {
        container.releasePointerCapture(session.pointerId);
      }
      if (session?.dragging) {
        // The mouse button is typically still down when a real drag stops
        // here (a normal pointerup, or Escape while still held), so a
        // trailing compatibility `click` event is still coming. Since the
        // drag may have moved well away from where it started, that click's
        // target is the nearest common ancestor of the start and end points
        // per the UI Events spec, which can easily read as "empty space" to
        // `isMarqueeStartTarget`; suppress it so it cannot wipe out the
        // selection this drag (or, on Escape, its restore) just produced.
        justDraggedRef.current = true;
        if (restore) {
          onChangeSelectionRef.current([...session.baseSelected]);
        }
      }
      sessionRef.current = null;
      setRect(null);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [containerRef],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && sessionRef.current !== null) {
        stop(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stop]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.button !== 0 || !isMarqueeStartTarget(event.target as Element | null)) {
        return;
      }
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const startClient: Point = { x: event.clientX, y: event.clientY };
      const startContent: Point = {
        x: event.clientX - containerRect.left + container.scrollLeft,
        y: event.clientY - containerRect.top + container.scrollTop,
      };
      sessionRef.current = {
        pointerId: event.pointerId,
        startContent,
        startClient,
        baseSelected: getSelectedRef.current(),
        mode: event.metaKey || event.ctrlKey || event.shiftKey ? "add" : "replace",
        dragging: false,
        latestClient: startClient,
      };
      container.setPointerCapture(event.pointerId);

      function handlePointerMove(moveEvent: PointerEvent) {
        const session = sessionRef.current;
        if (session === null || session.pointerId !== moveEvent.pointerId) {
          return;
        }
        session.latestClient = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!session.dragging && passesDragThreshold(session.startClient, session.latestClient)) {
          session.dragging = true;
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(tick);
          }
        }
      }

      function handlePointerUp(upEvent: PointerEvent) {
        const session = sessionRef.current;
        if (session === null || session.pointerId !== upEvent.pointerId) {
          return;
        }
        stop(false);
        cleanup();
      }

      function cleanup() {
        container?.removeEventListener("pointermove", handlePointerMove);
        container?.removeEventListener("pointerup", handlePointerUp);
        container?.removeEventListener("pointercancel", handlePointerUp);
      }

      container.addEventListener("pointermove", handlePointerMove);
      container.addEventListener("pointerup", handlePointerUp);
      container.addEventListener("pointercancel", handlePointerUp);
    }

    function handleClick(event: MouseEvent) {
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      if (isMarqueeStartTarget(event.target as Element | null)) {
        onClearSelectionRef.current();
      }
    }

    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("click", handleClick);
    };
  }, [containerRef, stop, tick]);

  return { rect };
}
