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
  ".ts": "video/mp2t",

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
  ".sh": "application/x-sh",
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

const INLINE_PREFIXES = ["image/", "video/", "audio/", "text/"];
const INLINE_EXACT = new Set(["application/pdf", "application/json"]);

/**
 * True when a MIME type is safe to render inline in the browser rather
 * than forcing a download: any `image/*`, `video/*`, `audio/*`, `text/*`,
 * plus `application/pdf` and `application/json`.
 */
export function isInlinePreviewable(mime: string): boolean {
  if (INLINE_EXACT.has(mime)) {
    return true;
  }
  return INLINE_PREFIXES.some((prefix) => mime.startsWith(prefix));
}
