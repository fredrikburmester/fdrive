import { describe, expect, it } from "vitest";
import {
  INDEXER_SETTINGS_DEFAULTS,
  INDEXER_SETTINGS_KEYS,
  indexerSettingsEntries,
  OCR_SETTINGS_DEFAULTS,
  OCR_SETTINGS_KEYS,
  ocrSettingsEntries,
  resolveIndexerSettings,
  resolveOcrSettings,
} from "./settings.js";

describe("resolveIndexerSettings", () => {
  it("falls back to every default when app.settings is empty", () => {
    const result = resolveIndexerSettings({});

    expect(result.values).toEqual({
      scanIntervalSeconds: INDEXER_SETTINGS_DEFAULTS.scanIntervalSeconds,
      workers: INDEXER_SETTINGS_DEFAULTS.workers,
      textExcludeGlobs: [],
      ocrImageGlobs: ["**"],
      tesseractLangs: INDEXER_SETTINGS_DEFAULTS.tesseractLangs,
    });
    expect(result.sources).toEqual({
      scanIntervalSeconds: "default",
      workers: "default",
      textExcludeGlobs: "default",
      ocrImageGlobs: "default",
      tesseractLangs: "default",
    });
  });

  it("prefers a valid stored override and marks it as settings-sourced", () => {
    const result = resolveIndexerSettings({
      [INDEXER_SETTINGS_KEYS.scanIntervalSeconds]: 60,
      [INDEXER_SETTINGS_KEYS.workers]: 8,
      [INDEXER_SETTINGS_KEYS.textExcludeGlobs]: ["**/tmp/**"],
      [INDEXER_SETTINGS_KEYS.ocrImageGlobs]: ["**/scans/**"],
      [INDEXER_SETTINGS_KEYS.tesseractLangs]: "eng",
    });

    expect(result.values).toEqual({
      scanIntervalSeconds: 60,
      workers: 8,
      textExcludeGlobs: ["**/tmp/**"],
      ocrImageGlobs: ["**/scans/**"],
      tesseractLangs: "eng",
    });
    expect(result.sources).toEqual({
      scanIntervalSeconds: "settings",
      workers: "settings",
      textExcludeGlobs: "settings",
      ocrImageGlobs: "settings",
      tesseractLangs: "settings",
    });
  });

  it("falls back to the default for a malformed stored value", () => {
    const result = resolveIndexerSettings({
      [INDEXER_SETTINGS_KEYS.scanIntervalSeconds]: "not a number",
      [INDEXER_SETTINGS_KEYS.workers]: 4.5,
      [INDEXER_SETTINGS_KEYS.textExcludeGlobs]: "not an array",
      [INDEXER_SETTINGS_KEYS.ocrImageGlobs]: [1, 2, 3],
      [INDEXER_SETTINGS_KEYS.tesseractLangs]: "   ",
    });

    expect(result.values).toEqual({
      scanIntervalSeconds: INDEXER_SETTINGS_DEFAULTS.scanIntervalSeconds,
      workers: INDEXER_SETTINGS_DEFAULTS.workers,
      textExcludeGlobs: [],
      ocrImageGlobs: ["**"],
      tesseractLangs: INDEXER_SETTINGS_DEFAULTS.tesseractLangs,
    });
    expect(result.sources).toEqual({
      scanIntervalSeconds: "default",
      workers: "default",
      textExcludeGlobs: "default",
      ocrImageGlobs: "default",
      tesseractLangs: "default",
    });
  });

  it("falls back to the default for an empty tesseractLangs string", () => {
    const result = resolveIndexerSettings({ [INDEXER_SETTINGS_KEYS.tesseractLangs]: "" });
    expect(result.values.tesseractLangs).toBe(INDEXER_SETTINGS_DEFAULTS.tesseractLangs);
    expect(result.sources.tesseractLangs).toBe("default");
  });
});

describe("indexerSettingsEntries", () => {
  it("builds every [key, value] pair to write", () => {
    const entries = indexerSettingsEntries({
      scanIntervalSeconds: 120,
      workers: 2,
      textExcludeGlobs: ["**/tmp/**"],
      ocrImageGlobs: [],
      tesseractLangs: "swe",
    });

    expect(entries).toEqual([
      [INDEXER_SETTINGS_KEYS.scanIntervalSeconds, 120],
      [INDEXER_SETTINGS_KEYS.workers, 2],
      [INDEXER_SETTINGS_KEYS.textExcludeGlobs, ["**/tmp/**"]],
      [INDEXER_SETTINGS_KEYS.ocrImageGlobs, []],
      [INDEXER_SETTINGS_KEYS.tesseractLangs, "swe"],
    ]);
  });
});

describe("resolveOcrSettings", () => {
  it("preserves safety excludes when saving an unrelated setting", () => {
    const shown = resolveOcrSettings({}).values;
    const stored = Object.fromEntries(ocrSettingsEntries({ ...shown, hour: 4 }));
    expect(stored[OCR_SETTINGS_KEYS.excludeGlobs]).toEqual([
      "Programs/**",
      "Photos/**",
      "Videos/**",
    ]);
    expect(resolveOcrSettings(stored).values.excludeGlobs).toEqual(shown.excludeGlobs);
  });

  it("respects an explicitly saved empty exclude list", () => {
    const resolved = resolveOcrSettings({ [OCR_SETTINGS_KEYS.excludeGlobs]: [] });
    expect(resolved.values.excludeGlobs).toEqual([]);
    expect(resolved.sources.excludeGlobs).toBe("settings");
  });

  it("falls back to every default when app.settings is empty", () => {
    const result = resolveOcrSettings({});

    expect(result.values).toEqual({
      hour: OCR_SETTINGS_DEFAULTS.hour,
      langs: OCR_SETTINGS_DEFAULTS.langs,
      excludeGlobs: ["Programs/**", "Photos/**", "Videos/**"],
      maxMb: OCR_SETTINGS_DEFAULTS.maxMb,
      keepOriginals: OCR_SETTINGS_DEFAULTS.keepOriginals,
    });
    expect(result.sources).toEqual({
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
    });
  });

  it("prefers a valid stored override and marks it as settings-sourced", () => {
    const result = resolveOcrSettings({
      [OCR_SETTINGS_KEYS.hour]: 5,
      [OCR_SETTINGS_KEYS.langs]: "eng",
      [OCR_SETTINGS_KEYS.excludeGlobs]: ["**/private/**"],
      [OCR_SETTINGS_KEYS.maxMb]: 50,
      [OCR_SETTINGS_KEYS.keepOriginals]: true,
    });

    expect(result.values).toEqual({
      hour: 5,
      langs: "eng",
      excludeGlobs: ["**/private/**"],
      maxMb: 50,
      keepOriginals: true,
    });
    expect(result.sources).toEqual({
      hour: "settings",
      langs: "settings",
      excludeGlobs: "settings",
      maxMb: "settings",
      keepOriginals: "settings",
    });
  });

  it("falls back to the default for a malformed keepOriginals value", () => {
    const result = resolveOcrSettings({ [OCR_SETTINGS_KEYS.keepOriginals]: "yes" });
    expect(result.values.keepOriginals).toBe(OCR_SETTINGS_DEFAULTS.keepOriginals);
    expect(result.sources.keepOriginals).toBe("default");
  });
});

describe("ocrSettingsEntries", () => {
  it("builds every [key, value] pair to write", () => {
    const entries = ocrSettingsEntries({
      hour: 4,
      langs: "eng",
      excludeGlobs: [],
      maxMb: 100,
      keepOriginals: true,
    });

    expect(entries).toEqual([
      [OCR_SETTINGS_KEYS.hour, 4],
      [OCR_SETTINGS_KEYS.langs, "eng"],
      [OCR_SETTINGS_KEYS.excludeGlobs, []],
      [OCR_SETTINGS_KEYS.maxMb, 100],
      [OCR_SETTINGS_KEYS.keepOriginals, true],
    ]);
  });
});
