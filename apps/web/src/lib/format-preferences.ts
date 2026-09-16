import { readJson, type StorageLike, writeJson } from "@/lib/files/storage";
import type { ClockFormat, DateStyle, SizeUnits } from "./format";

/** The per-browser choices that shape every size and date the app renders. */
export interface FormatPreferences {
  readonly sizes: SizeUnits;
  readonly dates: DateStyle;
  readonly clock: ClockFormat;
}

export type FormatPreferenceKey = keyof FormatPreferences;

export const DEFAULT_FORMAT_PREFERENCES: FormatPreferences = {
  sizes: "binary",
  dates: "relative",
  clock: "24h",
};

/** localStorage key per preference. */
export const FORMAT_STORAGE_KEYS: Record<FormatPreferenceKey, string> = {
  sizes: "fdrive.format.sizes",
  dates: "fdrive.format.dates",
  clock: "fdrive.format.clock",
};

export const SIZE_UNITS: readonly SizeUnits[] = ["binary", "decimal"];
export const DATE_STYLES: readonly DateStyle[] = ["relative", "absolute"];
export const CLOCK_FORMATS: readonly ClockFormat[] = ["24h", "12h"];

function isSizeUnits(value: unknown): value is SizeUnits {
  return value === "binary" || value === "decimal";
}
function isDateStyle(value: unknown): value is DateStyle {
  return value === "relative" || value === "absolute";
}
function isClockFormat(value: unknown): value is ClockFormat {
  return value === "24h" || value === "12h";
}

/** Reads every format preference from `storage`, falling back per key to the defaults. */
export function readFormatPreferences(storage: StorageLike): FormatPreferences {
  const defaults = DEFAULT_FORMAT_PREFERENCES;
  return {
    sizes: readJson(storage, FORMAT_STORAGE_KEYS.sizes, isSizeUnits, defaults.sizes),
    dates: readJson(storage, FORMAT_STORAGE_KEYS.dates, isDateStyle, defaults.dates),
    clock: readJson(storage, FORMAT_STORAGE_KEYS.clock, isClockFormat, defaults.clock),
  };
}

/** Persists one preference under its own `fdrive.format.*` key. */
export function writeFormatPreference<K extends FormatPreferenceKey>(
  storage: StorageLike,
  key: K,
  value: FormatPreferences[K],
): void {
  writeJson(storage, FORMAT_STORAGE_KEYS[key], value);
}
