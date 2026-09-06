import { describe, expect, it } from "vitest";
import {
  globsFromTextarea,
  globsToTextarea,
  indexerSettingsDirty,
  ocrSettingsDirty,
  validateIndexerSettings,
  validateOcrSettings,
} from "./settings";

describe("globsFromTextarea", () => {
  it("splits on newlines and trims each line", () => {
    expect(globsFromTextarea("**/tmp/**\n  **/cache/**  \n")).toEqual(["**/tmp/**", "**/cache/**"]);
  });

  it("drops blank lines", () => {
    expect(globsFromTextarea("**/tmp/**\n\n\n**/cache/**")).toEqual(["**/tmp/**", "**/cache/**"]);
  });

  it("returns an empty array for blank input", () => {
    expect(globsFromTextarea("   \n  \n")).toEqual([]);
  });
});

describe("globsToTextarea", () => {
  it("joins with newlines", () => {
    expect(globsToTextarea(["a", "b"])).toBe("a\nb");
  });

  it("returns an empty string for an empty list", () => {
    expect(globsToTextarea([])).toBe("");
  });
});

const SAVED_INDEXER = {
  scanIntervalSeconds: 900,
  workers: 4,
  textExcludeGlobs: ["a"],
  ocrImageGlobs: ["b"],
  tesseractLangs: "swe+eng",
};

describe("indexerSettingsDirty", () => {
  it("is false when the draft equals the saved values", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER })).toBe(false);
  });

  it("is true when scanIntervalSeconds differs", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, scanIntervalSeconds: 60 })).toBe(
      true,
    );
  });

  it("is true when workers differs", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, workers: 8 })).toBe(true);
  });

  it("is true when tesseractLangs differs", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, tesseractLangs: "eng" })).toBe(
      true,
    );
  });

  it("is true when textExcludeGlobs differs in content", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, textExcludeGlobs: ["c"] })).toBe(
      true,
    );
  });

  it("is true when textExcludeGlobs differs in length", () => {
    expect(
      indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, textExcludeGlobs: ["a", "c"] }),
    ).toBe(true);
  });

  it("is true when ocrImageGlobs differs", () => {
    expect(indexerSettingsDirty(SAVED_INDEXER, { ...SAVED_INDEXER, ocrImageGlobs: ["c"] })).toBe(
      true,
    );
  });
});

const SAVED_OCR = {
  hour: 3,
  langs: "swe+eng",
  excludeGlobs: ["a"],
  maxMb: 200,
  keepOriginals: false,
};

describe("ocrSettingsDirty", () => {
  it("is false when the draft equals the saved values", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR })).toBe(false);
  });

  it("is true when hour differs", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR, hour: 4 })).toBe(true);
  });

  it("is true when langs differs", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR, langs: "eng" })).toBe(true);
  });

  it("is true when maxMb differs", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR, maxMb: 100 })).toBe(true);
  });

  it("is true when keepOriginals differs", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR, keepOriginals: true })).toBe(true);
  });

  it("is true when excludeGlobs differs", () => {
    expect(ocrSettingsDirty(SAVED_OCR, { ...SAVED_OCR, excludeGlobs: ["c"] })).toBe(true);
  });
});

describe("validateIndexerSettings", () => {
  it("returns no messages for a valid draft", () => {
    expect(validateIndexerSettings(SAVED_INDEXER)).toEqual([]);
  });

  it("flags a scanIntervalSeconds below 30", () => {
    expect(validateIndexerSettings({ ...SAVED_INDEXER, scanIntervalSeconds: 10 })).toContain(
      "Scan interval must be between 30 and 86400 seconds.",
    );
  });

  it("flags a scanIntervalSeconds above 86400", () => {
    expect(validateIndexerSettings({ ...SAVED_INDEXER, scanIntervalSeconds: 100_000 })).toContain(
      "Scan interval must be between 30 and 86400 seconds.",
    );
  });

  it("flags a non-integer scanIntervalSeconds", () => {
    expect(validateIndexerSettings({ ...SAVED_INDEXER, scanIntervalSeconds: 30.5 })).toContain(
      "Scan interval must be between 30 and 86400 seconds.",
    );
  });

  it("flags workers out of range", () => {
    expect(validateIndexerSettings({ ...SAVED_INDEXER, workers: 0 })).toContain(
      "Workers must be between 1 and 16.",
    );
    expect(validateIndexerSettings({ ...SAVED_INDEXER, workers: 17 })).toContain(
      "Workers must be between 1 and 16.",
    );
  });

  it("flags an empty tesseractLangs", () => {
    expect(validateIndexerSettings({ ...SAVED_INDEXER, tesseractLangs: "   " })).toContain(
      "Tesseract languages must not be empty.",
    );
  });
});

describe("validateOcrSettings", () => {
  it("returns no messages for a valid draft", () => {
    expect(validateOcrSettings(SAVED_OCR)).toEqual([]);
  });

  it("flags an hour out of range", () => {
    expect(validateOcrSettings({ ...SAVED_OCR, hour: -1 })).toContain(
      "Hour must be between 0 and 23.",
    );
    expect(validateOcrSettings({ ...SAVED_OCR, hour: 24 })).toContain(
      "Hour must be between 0 and 23.",
    );
  });

  it("flags an empty langs", () => {
    expect(validateOcrSettings({ ...SAVED_OCR, langs: "" })).toContain(
      "Languages must not be empty.",
    );
  });

  it("flags a maxMb below 1", () => {
    expect(validateOcrSettings({ ...SAVED_OCR, maxMb: 0 })).toContain(
      "Max size must be at least 1 MB.",
    );
  });
});
