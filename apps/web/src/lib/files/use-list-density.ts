"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_LIST_DENSITY,
  type ListDensity,
  readListDensity,
  writeListDensity,
} from "./density";

const CHANGE_EVENT = "fdrive:list-density";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function snapshot(): ListDensity {
  return readListDensity(window.localStorage);
}

/** The browser's list density, shared by every mounted listing and other tabs. */
export function useListDensity() {
  const density = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LIST_DENSITY);
  return [density, setListDensity] as const;
}

export function setListDensity(density: ListDensity) {
  writeListDensity(window.localStorage, density);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
