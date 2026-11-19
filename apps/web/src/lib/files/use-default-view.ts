"use client";

import { useSyncExternalStore } from "react";
import { readListDesign } from "./list-design";
import { LIST_DESIGN_CHANGE_EVENT } from "./use-list-design";
import {
  DEFAULT_VIEW_MODE,
  defaultViewModeFor,
  readViewMode,
  type ViewMode,
  writeViewMode,
} from "./view-mode";

const CHANGE_EVENT = "fdrive:default-view";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener(LIST_DESIGN_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener(LIST_DESIGN_CHANGE_EVENT, listener);
  };
}

function snapshot(): ViewMode {
  const storage = window.localStorage;
  return readViewMode(storage, defaultViewModeFor(readListDesign(storage)));
}

/**
 * The browser default, shared by mounted listings and other tabs. Until one is set it follows
 * the File list setting, so the beta list starts as a tree.
 */
export function useDefaultView() {
  const mode = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_VIEW_MODE);
  return [mode, setDefaultView] as const;
}

export function setDefaultView(mode: ViewMode) {
  writeViewMode(window.localStorage, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
