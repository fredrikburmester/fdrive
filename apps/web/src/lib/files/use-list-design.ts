"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_LIST_DESIGN,
  type ListDesign,
  readListDesign,
  writeListDesign,
} from "./list-design";

/** Fired on this tab when the design changes; other tabs hear the `storage` event. */
export const LIST_DESIGN_CHANGE_EVENT = "fdrive:list-design";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(LIST_DESIGN_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(LIST_DESIGN_CHANGE_EVENT, listener);
  };
}

function snapshot(): ListDesign {
  return readListDesign(window.localStorage);
}

/** The browser's file list design, shared by every mounted listing, icon and other tabs. */
export function useListDesign() {
  const design = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LIST_DESIGN);
  return [design, setListDesign] as const;
}

export function setListDesign(design: ListDesign) {
  writeListDesign(window.localStorage, design);
  window.dispatchEvent(new Event(LIST_DESIGN_CHANGE_EVENT));
}
