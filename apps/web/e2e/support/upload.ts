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
 * This does not use Playwright's `setInputFiles`: in this repo's installed
 * Playwright/Chromium combination, `setInputFiles` (and the equivalent
 * `filechooser` + `setFiles()` flow) does fire a "change" event that reaches
 * React, but the `FileList` it hands back reads as empty by the time the
 * app's handler (which resets `input.value` before checking `files.length`,
 * a standard and normally-safe pattern for allowing the same file to be
 * re-selected) gets to it, so no upload is ever queued. Building the
 * `DataTransfer`/`File` in-page and assigning `input.files` directly via
 * `Object.defineProperty` (bypassing the input's native setter) before
 * dispatching a real "change" event does not have that problem, and every
 * step downstream (planning, the upload queue, the XHR) is exactly what a
 * real user's file selection would drive. See the module comment history /
 * PR description for the investigation; this looks like a Chromium/CDP file
 * input quirk in this Playwright version rather than an fdrive bug, since a
 * real user's file selection is unaffected (the same closure works fine
 * when driven by a genuine browser change event with an organically
 * produced `FileList`).
 */
export async function selectFilesForUpload(
  fileInput: Locator,
  files: readonly UploadFileSpec[],
): Promise<void> {
  const payload = files.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    base64: Buffer.from(file.contents, "utf-8").toString("base64"),
  }));

  await fileInput.evaluate((element, filesData) => {
    const dataTransfer = new DataTransfer();
    for (const file of filesData) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      dataTransfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    Object.defineProperty(element, "files", { value: dataTransfer.files, configurable: true });
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, payload);
}

/** The file browser's hidden, non-directory file input (the first of the two hidden file inputs). */
export function fileInputLocator(page: Page): Locator {
  return page.locator('input[type="file"]').first();
}

/** Uploads `files` via the file browser's hidden file input; see `selectFilesForUpload`. */
export async function uploadFiles(page: Page, files: readonly UploadFileSpec[]): Promise<void> {
  await selectFilesForUpload(fileInputLocator(page), files);
}
