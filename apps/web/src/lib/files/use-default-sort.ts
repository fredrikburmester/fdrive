"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_SORT_SPEC,
  readSortSpec,
  SORT_STORAGE_KEY,
  type SortSpec,
  writeSortSpec,
} from "./sorting";

const CHANGE_EVENT = "fdrive:default-sort";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

let cached: { readonly raw: string | null; readonly spec: SortSpec } | null = null;

function rawStored(): string | null {
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * `useSyncExternalStore` needs a referentially stable snapshot while the
 * store is unchanged, so the parsed spec is cached against the raw string.
 */
function snapshot(): SortSpec {
  const raw = rawStored();
  if (cached === null || cached.raw !== raw) {
    cached = { raw, spec: readSortSpec(window.localStorage) };
  }
  return cached.spec;
}

/** The browser's default sort, shared by mounted listings and other tabs. */
export function useDefaultSort() {
  const spec = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SORT_SPEC);
  return [spec, setDefaultSort] as const;
}

export function setDefaultSort(spec: SortSpec) {
  writeSortSpec(window.localStorage, spec);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
