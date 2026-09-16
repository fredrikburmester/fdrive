"use client";

import { useMemo, useSyncExternalStore } from "react";
import { formatBytes, formatDate } from "./format";
import {
  DEFAULT_FORMAT_PREFERENCES,
  FORMAT_STORAGE_KEYS,
  type FormatPreferenceKey,
  type FormatPreferences,
  readFormatPreferences,
  writeFormatPreference,
} from "./format-preferences";

const CHANGE_EVENT = "fdrive:format-preferences";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

let cached: { readonly raw: string; readonly prefs: FormatPreferences } | null = null;

function rawStored(): string {
  try {
    return Object.values(FORMAT_STORAGE_KEYS)
      .map((key) => window.localStorage.getItem(key) ?? "")
      .join("|");
  } catch {
    return "";
  }
}

/**
 * `useSyncExternalStore` needs a referentially stable snapshot while the
 * store is unchanged, so the parsed object is cached against the raw strings.
 */
function snapshot(): FormatPreferences {
  const raw = rawStored();
  if (cached === null || cached.raw !== raw) {
    cached = { raw, prefs: readFormatPreferences(window.localStorage) };
  }
  return cached.prefs;
}

/** The browser's format preferences, shared by every mounted consumer and other tabs. */
export function useFormatPreferences() {
  const prefs = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_FORMAT_PREFERENCES);
  return [prefs, setFormatPreference] as const;
}

export function setFormatPreference<K extends FormatPreferenceKey>(
  key: K,
  value: FormatPreferences[K],
) {
  writeFormatPreference(window.localStorage, key, value);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `formatBytes` and `formatDate` bound to the browser's current preferences. */
export function useFormatters() {
  const [prefs] = useFormatPreferences();
  return useMemo(
    () => ({
      prefs,
      formatBytes: (bytes: number) => formatBytes(bytes, { units: prefs.sizes }),
      formatDate: (date: Date) => formatDate(date, { style: prefs.dates, clock: prefs.clock }),
    }),
    [prefs],
  );
}
