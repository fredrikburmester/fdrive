import type {
  IndexerSettingsResponse,
  IndexerSettingsUpdateRequest,
  OcrSettingsResponse,
  OcrSettingsUpdateRequest,
  SettingSource,
} from "@fdrive/contracts";

/**
 * The `app.settings` keys the indexer reads at the start of every scan
 * cycle, matching `docs/INDEXER.md` and `services/indexer/src/fdrive_indexer/settings.py`.
 */
export const INDEXER_SETTINGS_KEYS = {
  scanIntervalSeconds: "indexer.scan_interval_seconds",
  workers: "indexer.workers",
  textExcludeGlobs: "indexer.text_exclude_globs",
  ocrImageGlobs: "indexer.ocr_image_globs",
  tesseractLangs: "indexer.tesseract_langs",
} as const;

/**
 * The env-derived defaults the indexer itself falls back to
 * (`services/indexer/src/fdrive_indexer/config.py`), used here so the
 * System > Indexer page can show a value even before an admin has ever
 * saved an override.
 */
export const INDEXER_SETTINGS_DEFAULTS = {
  scanIntervalSeconds: 900,
  workers: 4,
  textExcludeGlobs: [] as readonly string[],
  ocrImageGlobs: [] as readonly string[],
  tesseractLangs: "swe+eng",
};

/**
 * The `app.settings` keys the OCR service reads. See PLAN.md §9 and the
 * chunk brief; the OCR service itself is being built in parallel.
 */
export const OCR_SETTINGS_KEYS = {
  hour: "ocr.hour",
  langs: "ocr.langs",
  excludeGlobs: "ocr.exclude_globs",
  maxMb: "ocr.max_mb",
  keepOriginals: "ocr.keep_originals",
} as const;

/**
 * Assumed env-derived defaults for the OCR service, since it ships no
 * documented default table yet: a nightly run at 03:00, the same language
 * pack as the indexer's OCR fallback, no folders excluded, a 200 MB cap per
 * file, and originals discarded after a successful pass.
 */
export const OCR_SETTINGS_DEFAULTS = {
  hour: 3,
  langs: "swe+eng",
  excludeGlobs: [] as readonly string[],
  maxMb: 200,
  keepOriginals: false,
};

/** One resolved value plus where it came from, for building a `*SettingsResponse`. */
interface Resolved<T> {
  readonly value: T;
  readonly source: SettingSource;
}

function parseInt_(raw: unknown, fallback: number): Resolved<number> {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return { value: raw, source: "settings" };
  }
  return { value: fallback, source: "default" };
}

function parseGlobList(raw: unknown, fallback: readonly string[]): Resolved<string[]> {
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return { value: raw, source: "settings" };
  }
  return { value: [...fallback], source: "default" };
}

function parseStr(raw: unknown, fallback: string): Resolved<string> {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return { value: raw, source: "settings" };
  }
  return { value: fallback, source: "default" };
}

function parseBool(raw: unknown, fallback: boolean): Resolved<boolean> {
  if (typeof raw === "boolean") {
    return { value: raw, source: "settings" };
  }
  return { value: fallback, source: "default" };
}

/**
 * Resolves the indexer's five settings from `raw` (the full `app.settings`
 * table, as returned by `SettingsRepo.all()`), falling back to
 * `INDEXER_SETTINGS_DEFAULTS` and marking each field's source. Tolerant of
 * missing keys and malformed values, mirroring the indexer's own
 * `settings.py` parsing rules.
 */
export function resolveIndexerSettings(raw: Record<string, unknown>): IndexerSettingsResponse {
  const scanIntervalSeconds = parseInt_(
    raw[INDEXER_SETTINGS_KEYS.scanIntervalSeconds],
    INDEXER_SETTINGS_DEFAULTS.scanIntervalSeconds,
  );
  const workers = parseInt_(raw[INDEXER_SETTINGS_KEYS.workers], INDEXER_SETTINGS_DEFAULTS.workers);
  const textExcludeGlobs = parseGlobList(
    raw[INDEXER_SETTINGS_KEYS.textExcludeGlobs],
    INDEXER_SETTINGS_DEFAULTS.textExcludeGlobs,
  );
  const ocrImageGlobs = parseGlobList(
    raw[INDEXER_SETTINGS_KEYS.ocrImageGlobs],
    INDEXER_SETTINGS_DEFAULTS.ocrImageGlobs,
  );
  const tesseractLangs = parseStr(
    raw[INDEXER_SETTINGS_KEYS.tesseractLangs],
    INDEXER_SETTINGS_DEFAULTS.tesseractLangs,
  );

  return {
    values: {
      scanIntervalSeconds: scanIntervalSeconds.value,
      workers: workers.value,
      textExcludeGlobs: textExcludeGlobs.value,
      ocrImageGlobs: ocrImageGlobs.value,
      tesseractLangs: tesseractLangs.value,
    },
    sources: {
      scanIntervalSeconds: scanIntervalSeconds.source,
      workers: workers.source,
      textExcludeGlobs: textExcludeGlobs.source,
      ocrImageGlobs: ocrImageGlobs.source,
      tesseractLangs: tesseractLangs.source,
    },
  };
}

/** Every `[key, value]` pair `PUT /system/indexer/settings` writes to `app.settings`. */
export function indexerSettingsEntries(
  update: IndexerSettingsUpdateRequest,
): readonly (readonly [string, unknown])[] {
  return [
    [INDEXER_SETTINGS_KEYS.scanIntervalSeconds, update.scanIntervalSeconds],
    [INDEXER_SETTINGS_KEYS.workers, update.workers],
    [INDEXER_SETTINGS_KEYS.textExcludeGlobs, update.textExcludeGlobs],
    [INDEXER_SETTINGS_KEYS.ocrImageGlobs, update.ocrImageGlobs],
    [INDEXER_SETTINGS_KEYS.tesseractLangs, update.tesseractLangs],
  ];
}

/**
 * Resolves the OCR service's five settings from `raw`, the same way
 * `resolveIndexerSettings` does for the indexer.
 */
export function resolveOcrSettings(raw: Record<string, unknown>): OcrSettingsResponse {
  const hour = parseInt_(raw[OCR_SETTINGS_KEYS.hour], OCR_SETTINGS_DEFAULTS.hour);
  const langs = parseStr(raw[OCR_SETTINGS_KEYS.langs], OCR_SETTINGS_DEFAULTS.langs);
  const excludeGlobs = parseGlobList(
    raw[OCR_SETTINGS_KEYS.excludeGlobs],
    OCR_SETTINGS_DEFAULTS.excludeGlobs,
  );
  const maxMb = parseInt_(raw[OCR_SETTINGS_KEYS.maxMb], OCR_SETTINGS_DEFAULTS.maxMb);
  const keepOriginals = parseBool(
    raw[OCR_SETTINGS_KEYS.keepOriginals],
    OCR_SETTINGS_DEFAULTS.keepOriginals,
  );

  return {
    values: {
      hour: hour.value,
      langs: langs.value,
      excludeGlobs: excludeGlobs.value,
      maxMb: maxMb.value,
      keepOriginals: keepOriginals.value,
    },
    sources: {
      hour: hour.source,
      langs: langs.source,
      excludeGlobs: excludeGlobs.source,
      maxMb: maxMb.source,
      keepOriginals: keepOriginals.source,
    },
  };
}

/** Every `[key, value]` pair `PUT /system/ocr/settings` writes to `app.settings`. */
export function ocrSettingsEntries(
  update: OcrSettingsUpdateRequest,
): readonly (readonly [string, unknown])[] {
  return [
    [OCR_SETTINGS_KEYS.hour, update.hour],
    [OCR_SETTINGS_KEYS.langs, update.langs],
    [OCR_SETTINGS_KEYS.excludeGlobs, update.excludeGlobs],
    [OCR_SETTINGS_KEYS.maxMb, update.maxMb],
    [OCR_SETTINGS_KEYS.keepOriginals, update.keepOriginals],
  ];
}
