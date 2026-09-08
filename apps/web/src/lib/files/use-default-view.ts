"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_VIEW_MODE, readViewMode, type ViewMode, writeViewMode } from "./view-mode";

const CHANGE_EVENT = "fdrive:default-view";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function snapshot(): ViewMode {
  return readViewMode(window.localStorage);
}

/** The existing browser default, shared by mounted listings and other tabs. */
export function useDefaultView() {
  const mode = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_VIEW_MODE);
  return [mode, setDefaultView] as const;
}

export function setDefaultView(mode: ViewMode) {
  writeViewMode(window.localStorage, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
