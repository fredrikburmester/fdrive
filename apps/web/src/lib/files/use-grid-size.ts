"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_GRID_SIZE, type GridSize, readGridSize, writeGridSize } from "./grid-size";

const CHANGE_EVENT = "fdrive:grid-size";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function snapshot(): GridSize {
  return readGridSize(window.localStorage);
}

/** The browser's grid size, shared by every mounted grid and other tabs. */
export function useGridSize() {
  const size = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_GRID_SIZE);
  return [size, setGridSize] as const;
}

export function setGridSize(size: GridSize) {
  writeGridSize(window.localStorage, size);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
