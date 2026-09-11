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

/**
 * Adapts the real, global `document` to the minimal `DocumentLike` above,
 * so every caller clicks its download anchor the same way. The cast is
 * confined to this one boundary: the downloader only ever calls the
 * methods that narrow interface declares (create one anchor, append it,
 * click it, remove it), so this is safe even though a real `Node` is
 * structurally much larger than `AnchorLike`.
 */
export function adaptDocument(doc: Document): DocumentLike {
  return {
    createElement: (tag) => doc.createElement(tag),
    body: {
      appendChild: (node) => {
        doc.body.appendChild(node as unknown as Node);
      },
      removeChild: (node) => {
        doc.body.removeChild(node as unknown as Node);
      },
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

/** The `DownloadDeps` members a download from an object URL needs. */
export type ObjectUrlDownloadDeps = Pick<DownloadDeps, "anchor" | "revokeObjectUrl">;

/**
 * Clicks a hidden anchor pointing at an object `url`, then releases that
 * URL one task later. Clicking only *starts* the download: the browser
 * reads the blob while handling the anchor's activation, which is not
 * guaranteed to be finished when `click()` returns, so revoking in the
 * same task risks a silently empty file. Waiting a task keeps the URL
 * alive across the click without holding the blob any longer than that.
 * The URL is released even when the click throws.
 */
export function downloadObjectUrl(
  url: string,
  filename: string,
  deps: ObjectUrlDownloadDeps,
): void {
  try {
    deps.anchor.click(url, filename);
  } finally {
    setTimeout(() => {
      deps.revokeObjectUrl(url);
    }, 0);
  }
}

/**
 * Whether downloading `entries` should go through the zip path rather than
 * a direct single-file download: any selection of more than one entry, or a
 * single folder (folders have no direct-download byte stream of their own).
 */
export function needsZipDownload(entries: readonly { kind: string }[]): boolean {
  return entries.length !== 1 || entries.some((entry) => entry.kind === "dir");
}

/** How a download of some entries is carried out, by `planDownload`. */
export type DownloadPlan =
  | { readonly kind: "single"; readonly path: string }
  | { readonly kind: "zip"; readonly paths: string[] }
  | { readonly kind: "each"; readonly paths: string[] };

/**
 * Decides how to download `entries` for a login whose provider may lack
 * the `zip` capability: one file streams directly; with `zip`, anything
 * else becomes one archive; without it, every file is downloaded on its
 * own and folders are skipped (they have no byte stream to hand out).
 * Returns `null` when there is nothing to download.
 */
export function planDownload(
  entries: readonly { kind: string; path: string }[],
  zip: boolean,
): DownloadPlan | null {
  const first = entries[0];
  if (first === undefined) return null;
  if (!needsZipDownload(entries)) return { kind: "single", path: first.path };
  if (zip) return { kind: "zip", paths: entries.map((entry) => entry.path) };
  const files = entries.filter((entry) => entry.kind !== "dir").map((entry) => entry.path);
  if (files.length === 0) return null;
  return { kind: "each", paths: files };
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
 * is always released, even if the click throws.
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
  downloadObjectUrl(deps.createObjectUrl(blob), name ?? DEFAULT_ZIP_NAME, deps);
}
