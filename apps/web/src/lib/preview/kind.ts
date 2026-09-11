/**
 * The category of preview the viewer route knows how to render. "none"
 * means fdrive has no built-in viewer (or the file is too large to load
 * inline); the unsupported viewer offers a download instead.
 */
export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "office"
  | "archive"
  | "none";

/** The minimal entry shape `previewKindFor` needs. */
export interface PreviewableEntry {
  readonly ext: string;
  readonly mime: string | null;
  readonly size: number;
}

/**
 * Text-like kinds (markdown, code, text) are only previewed inline up to
 * this many bytes. Larger files fall back to "none" so the browser is not
 * asked to load an unbounded amount of text.
 */
export const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

/** Image extensions the browser cannot decode itself; `lib/preview/heic.ts` handles them. */
export const HEIC_EXTENSIONS: ReadonlySet<string> = new Set([".heic", ".heif"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".svg",
  ...HEIC_EXTENSIONS,
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"]);

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus"]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
]);

const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tar.zst",
  ".gz",
  ".7z",
  ".rar",
]);

/** Extension to language identifier, for `code-viewer`'s language badge. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  // `.ts` collides with the MPEG transport stream video extension
  // (`video/mp2t`), and `.mts` further collides with AVCHD video. Both
  // resolve to TypeScript here: see `baseKindFor`, where extension-based
  // code detection is checked before any mime-based media detection.
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".xml": "xml",
  ".sh": "bash",
  ".bash": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".graphql": "graphql",
  ".proto": "protobuf",
};

const CODE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

const TEXT_EXTENSIONS = new Set([".txt", ".log", ".csv", ".tsv", ".ini", ".env", ".conf"]);

/**
 * Guesses a language identifier for `code-viewer`'s language badge, from a
 * file extension (with leading dot, case-insensitive). Falls back to
 * "plaintext" for any extension without a known mapping.
 */
export function languageFor(ext: string): string {
  return LANGUAGE_BY_EXTENSION[ext.toLowerCase()] ?? "plaintext";
}

/**
 * Determines the base preview kind for `entry`, before the text-size cap is
 * applied. Extension-based detection for code, markdown, office, archive,
 * and plain-text extensions always runs first, ahead of any mime-based
 * image/video/audio/pdf decision. This matters because a few code
 * extensions collide with legacy media mime types (`.ts` and `video/mp2t`,
 * the MPEG transport stream type, most notably): trusting the extension
 * keeps those files in the code viewer instead of the video viewer. Once
 * the extension is not one of those known non-media kinds, media kinds fall
 * back to the mime type (or a matching media extension).
 */
function baseKindFor(entry: PreviewableEntry): PreviewKind {
  const ext = entry.ext.toLowerCase();
  const mime = entry.mime ?? "";

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return "code";
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return "office";
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return "archive";
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }

  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (mime === "application/pdf" || ext === ".pdf") {
    return "pdf";
  }
  if (mime.startsWith("text/")) {
    return "text";
  }
  return "none";
}

const TEXT_LIKE_KINDS: ReadonlySet<PreviewKind> = new Set(["markdown", "code", "text"]);

/**
 * Determines which built-in viewer, if any, applies to `entry`. Text-like
 * kinds (markdown, code, plain text) fall back to "none" once `entry.size`
 * exceeds `TEXT_LIMIT_BYTES`; every other kind has no size cap here (the
 * API still enforces its own limits on download).
 */
export function previewKindFor(entry: PreviewableEntry): PreviewKind {
  const kind = baseKindFor(entry);
  if (TEXT_LIKE_KINDS.has(kind) && entry.size > TEXT_LIMIT_BYTES) {
    return "none";
  }
  return kind;
}

/**
 * A short explanation for why `previewKindFor(entry)` returned "none",
 * or `null` when a preview reason does not apply (including when the
 * entry is previewable). Used by the unsupported viewer and the
 * inspector.
 */
export function previewUnavailableReason(entry: PreviewableEntry): string | null {
  if (previewKindFor(entry) !== "none") {
    return null;
  }
  const kind = baseKindFor(entry);
  if (TEXT_LIKE_KINDS.has(kind) && entry.size > TEXT_LIMIT_BYTES) {
    return "This file is larger than 2 MiB, so it is not previewed inline.";
  }
  return "fdrive does not have a built-in preview for this file type.";
}
