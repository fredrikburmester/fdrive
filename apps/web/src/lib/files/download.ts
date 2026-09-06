/** The minimal anchor shape a hidden `<a>` download link needs. */
export interface AnchorLike {
  href: string;
  rel: string;
  download: string;
  style: { display: string };
  click(): void;
}

/** The minimal `document` shape needed to append and click a hidden anchor. */
export interface DocumentLike {
  createElement(tag: "a"): AnchorLike;
  body: {
    appendChild(node: AnchorLike): void;
    removeChild(node: AnchorLike): void;
  };
}

export interface AnchorDownloader {
  /** Appends a hidden anchor pointing at `url`, clicks it, then removes it. */
  click(url: string, filename?: string): void;
}

/** Builds an `AnchorDownloader` backed by a real (or fake) `document`. */
export function createAnchorDownloader(doc: DocumentLike): AnchorDownloader {
  return {
    click(url, filename) {
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      if (filename !== undefined) {
        anchor.download = filename;
      }
      doc.body.appendChild(anchor);
      anchor.click();
      doc.body.removeChild(anchor);
    },
  };
}

export interface DownloadDeps {
  downloadUrl(path: string, opts?: { inline?: boolean }): string;
  zip(paths: string[], name?: string): Promise<Response>;
  anchor: AnchorDownloader;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

/**
 * Whether downloading `entries` should go through the zip path rather than
 * a direct single-file download: any selection of more than one entry, or a
 * single folder (folders have no direct-download byte stream of their own).
 */
export function needsZipDownload(entries: readonly { kind: string }[]): boolean {
  return entries.length !== 1 || entries.some((entry) => entry.kind === "dir");
}

/** Navigates a hidden anchor to the direct download URL for `path`. */
export function downloadSingle(path: string, deps: DownloadDeps): void {
  const url = deps.downloadUrl(path, { inline: false });
  deps.anchor.click(url);
}

const DEFAULT_ZIP_NAME = "download.zip";

/**
 * Requests a zip of `paths` from the API, buffers it into a `Blob`, and
 * clicks a hidden anchor pointing at an object URL for it. The object URL
 * is always revoked, even if the click throws.
 */
export async function downloadMany(
  paths: string[],
  deps: DownloadDeps,
  name?: string,
): Promise<void> {
  const response = await deps.zip(paths, name);
  if (!response.ok) {
    throw new Error(`zip request failed with status ${response.status}`);
  }

  const blob = await response.blob();
  const url = deps.createObjectUrl(blob);
  try {
    deps.anchor.click(url, name ?? DEFAULT_ZIP_NAME);
  } finally {
    deps.revokeObjectUrl(url);
  }
}
