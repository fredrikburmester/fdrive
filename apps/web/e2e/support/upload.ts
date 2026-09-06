import type { Locator, Page } from "@playwright/test";

export interface UploadFileSpec {
  readonly name: string;
  readonly mimeType: string;
  readonly contents: string;
}

/**
 * Selects `files` on the file browser's hidden (non-directory) file input
 * and lets the app's own change handler take it from there.
 *
 * Uses Playwright's plain `setInputFiles`. An earlier version of this helper
 * worked around the app's `handleFileInputChange` reading `input.files`
 * after resetting `input.value` (see `src/components/files/file-browser.tsx`),
 * which made the `FileList` it received read as empty; that handler now
 * copies the `FileList` to an array before resetting, so the plain
 * Playwright flow works like a real user's file selection.
 */
export async function selectFilesForUpload(
  fileInput: Locator,
  files: readonly UploadFileSpec[],
): Promise<void> {
  await fileInput.setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.contents, "utf-8"),
    })),
  );
}

/** The file browser's hidden, non-directory file input (the first of the two hidden file inputs). */
export function fileInputLocator(page: Page): Locator {
  return page.locator('input[type="file"]').first();
}

/** Uploads `files` via the file browser's hidden file input; see `selectFilesForUpload`. */
export async function uploadFiles(page: Page, files: readonly UploadFileSpec[]): Promise<void> {
  await selectFilesForUpload(fileInputLocator(page), files);
}
