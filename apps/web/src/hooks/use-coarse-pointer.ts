import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function mediaQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(listener: () => void) {
  const query = mediaQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/**
 * True on a touch screen, whose pointer cannot hover: controls that a mouse finds by
 * hovering a row stay visible there instead.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery()?.matches ?? false,
    () => false,
  );
}
