/**
 * Extension (with leading dot, lowercase) to MIME type, for the common web,
 * image, audio, video, document, archive, code, and Office types. Keys
 * match the shape `extensionOf` (from `./paths.js`) returns, including its
 * compound archive suffixes (`.tar.gz` and friends).
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  // Web
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",

  // Camera raw. Not inline-previewable: browsers cannot decode them, so the
  // web app shows the indexer's thumbnail and serves the file as a download.
  ".arw": "image/x-sony-arw",
  ".sr2": "image/x-sony-sr2",
  ".srf": "image/x-sony-srf",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".crw": "image/x-canon-crw",
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nrw",
  ".dng": "image/x-adobe-dng",
  ".raf": "image/x-fuji-raf",
  ".orf": "image/x-olympus-orf",
  ".rw2": "image/x-panasonic-rw2",
  ".pef": "image/x-pentax-pef",

  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
  ".opus": "audio/opus",

  // Video
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".m2ts": "video/mp2t",

  // Documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".ics": "text/calendar",

  // Office (legacy and OOXML/OpenDocument)
  ".doc": "application/msword",
  ".dot": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potx": "application/vnd.openxmlformats-officedocument.presentationml.template",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",

  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar.gz": "application/gzip",
  ".tar.bz2": "application/x-bzip2",
  ".tar.xz": "application/x-xz",
  ".tar.zst": "application/zstd",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",

  // Code
  // `.ts` is ambiguous: TypeScript source vs. an MPEG transport stream
  // video. A file manager reading `.ts` files is the far more common case,
  // so TypeScript wins here. Same reasoning for `.mts`/`.cts`, where `.mts`
  // also collides with AVCHD video (that container uses `.m2ts` instead, see
  // above, so the collision is avoided in practice).
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".php": "application/x-httpd-php",
  ".sh": "text/x-sh",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".sql": "application/sql",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
};

/**
 * Looks up the MIME type for a lowercase extension (with leading dot, as
 * `extensionOf` returns). `null` when the extension is unknown or empty
 * (always the case for directories, since `extensionOf` returns "" for
 * them).
 */
export function mimeFromExtension(ext: string): string | null {
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? null;
}

// Only known passive formats may become documents on the authenticated origin.
const INLINE_EXACT = new Set([
  "application/pdf",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
  "audio/opus",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/mpeg",
  "video/3gpp",
  "video/mp2t",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/calendar",
  "text/css",
  "text/javascript",
  "text/typescript",
  "text/tsx",
  "text/jsx",
  "text/x-python",
  "text/x-ruby",
  "text/x-go",
  "text/x-rust",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++",
  "text/x-csharp",
  "text/x-sh",
  "text/x-swift",
  "text/x-kotlin",
]);

/**
 * True for an explicitly supported passive MIME type. Active documents (including
 * HTML, SVG and XML) and unknown types must download even when inline is requested.
 */
export function isInlinePreviewable(mime: string): boolean {
  return INLINE_EXACT.has(mime.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}
