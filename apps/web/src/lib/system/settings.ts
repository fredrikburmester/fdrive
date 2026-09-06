import type { IndexerSettingsValue, OcrSettingsValue } from "@fdrive/contracts";

/**
 * Splits a glob-list textarea's raw text into one trimmed, non-empty
 * pattern per line. Blank lines are dropped, so an admin can leave
 * spacing in the textarea without it becoming a literal empty-string glob.
 */
export function globsFromTextarea(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The inverse of {@link globsFromTextarea}: one pattern per line. */
export function globsToTextarea(globs: readonly string[]): string {
  return globs.join("\n");
}

/**
 * True when any field of `draft` differs from `saved`. Arrays are compared
 * order-sensitively (as the textarea reflects it), which is enough for the
 * Save button's disabled state; it does not need to detect a reordering
 * that produces an identical effective set as "clean".
 */
export function indexerSettingsDirty(
  saved: IndexerSettingsValue,
  draft: IndexerSettingsValue,
): boolean {
  return (
    saved.scanIntervalSeconds !== draft.scanIntervalSeconds ||
    saved.workers !== draft.workers ||
    saved.tesseractLangs !== draft.tesseractLangs ||
    !arraysEqual(saved.textExcludeGlobs, draft.textExcludeGlobs) ||
    !arraysEqual(saved.ocrImageGlobs, draft.ocrImageGlobs)
  );
}

/** Same comparison as {@link indexerSettingsDirty}, for the OCR settings form. */
export function ocrSettingsDirty(saved: OcrSettingsValue, draft: OcrSettingsValue): boolean {
  return (
    saved.hour !== draft.hour ||
    saved.langs !== draft.langs ||
    saved.maxMb !== draft.maxMb ||
    saved.keepOriginals !== draft.keepOriginals ||
    !arraysEqual(saved.excludeGlobs, draft.excludeGlobs)
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Validation messages for an indexer settings draft, matching the API's
 * `IndexerSettingsUpdateRequest` bounds exactly so the Save button can be
 * disabled (and the reason shown) before a round trip to the server.
 * Empty when the draft is valid.
 */
export function validateIndexerSettings(draft: IndexerSettingsValue): string[] {
  const messages: string[] = [];
  if (
    !Number.isInteger(draft.scanIntervalSeconds) ||
    draft.scanIntervalSeconds < 30 ||
    draft.scanIntervalSeconds > 86400
  ) {
    messages.push("Scan interval must be between 30 and 86400 seconds.");
  }
  if (!Number.isInteger(draft.workers) || draft.workers < 1 || draft.workers > 16) {
    messages.push("Workers must be between 1 and 16.");
  }
  if (draft.tesseractLangs.trim().length === 0) {
    messages.push("Tesseract languages must not be empty.");
  }
  return messages;
}

/** Same idea as {@link validateIndexerSettings}, matching `OcrSettingsUpdateRequest`. */
export function validateOcrSettings(draft: OcrSettingsValue): string[] {
  const messages: string[] = [];
  if (!Number.isInteger(draft.hour) || draft.hour < 0 || draft.hour > 23) {
    messages.push("Hour must be between 0 and 23.");
  }
  if (draft.langs.trim().length === 0) {
    messages.push("Languages must not be empty.");
  }
  if (!Number.isInteger(draft.maxMb) || draft.maxMb < 1) {
    messages.push("Max size must be at least 1 MB.");
  }
  return messages;
}
