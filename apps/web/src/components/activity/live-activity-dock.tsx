"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

const LiveActivityDockContext = createContext<HTMLElement | null>(null);

/**
 * The one corner where live activities show while their own UI is closed:
 * a fixed column at the bottom right in which the activity panel (uploads
 * and jobs, anchored at the bottom with `order-last`) and the Organize pill
 * stack. Activities render into it through `LiveActivity` from wherever
 * they are mounted, so they share the corner instead of covering one
 * another. The dock lets
 * pointer events through, so an empty corner never blocks what is under it.
 */
export function LiveActivityDock({ children }: { children?: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <LiveActivityDockContext.Provider value={node}>
      {children}
      <div
        ref={setNode}
        data-slot="live-activity-dock"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2 *:pointer-events-auto max-md:inset-x-3 max-md:right-3"
      />
    </LiveActivityDockContext.Provider>
  );
}

/**
 * Renders `children` in the `LiveActivityDock`. Without a dock (a test
 * rendering one activity on its own) they render in place instead.
 */
export function LiveActivity({ children }: { children: ReactNode }) {
  const node = useContext(LiveActivityDockContext);
  return node === null ? children : createPortal(children, node);
}
