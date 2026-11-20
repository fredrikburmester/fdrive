"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  INSPECTOR_SIDE_PANEL_QUERY,
  readInspectorOpen,
  writeInspectorOpen,
} from "./inspector-visibility";

const CHANGE_EVENT = "fdrive:inspector-open";

/** The side panel's stored state, or "sheet" where the window is too narrow for a side panel. */
type PanelState = "open" | "closed" | "sheet";

function sidePanelQuery(): MediaQueryList {
  return window.matchMedia(INSPECTOR_SIDE_PANEL_QUERY);
}

function subscribe(listener: () => void) {
  const query = sidePanelQuery();
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  query.addEventListener("change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
    query.removeEventListener("change", listener);
  };
}

function snapshot(): PanelState {
  if (!sidePanelQuery().matches) {
    return "sheet";
  }
  return readInspectorOpen(window.localStorage) ? "open" : "closed";
}

function serverSnapshot(): PanelState {
  return "closed";
}

/**
 * Whether the details panel is open, and its setter. Beside the listing it follows this
 * browser's stored choice, open by default. Where the window is too narrow for a side panel it
 * is a sheet, which starts closed on every load, closes when the window narrows under an open
 * side panel, and is never stored: opening or closing a sheet says nothing about the side panel.
 */
export function useInspectorOpen() {
  const panel = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const isSheet = panel === "sheet";
  const [sheetOpen, setSheetOpen] = useState(false);

  // A sheet left open must not come back the next time the window narrows.
  useEffect(() => {
    if (!isSheet) {
      setSheetOpen(false);
    }
  }, [isSheet]);

  const setOpen = useCallback(
    (open: boolean) => {
      if (isSheet) {
        setSheetOpen(open);
      } else {
        setInspectorOpen(open);
      }
    },
    [isSheet],
  );

  return [isSheet ? sheetOpen : panel === "open", setOpen] as const;
}

/** Stores whether the side panel is open and tells every mounted listing. */
export function setInspectorOpen(open: boolean) {
  writeInspectorOpen(window.localStorage, open);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
