import type { EntryKind } from "@fdrive/core";

export type FileIconKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "archive"
  | "code"
  | "presentation"
  | "table"
  | "file";

const ARCHIVE_EXTS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".bz2",
  ".xz",
  ".zst",
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tar.zst",
]);

const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".scss",
  ".html",
  ".sql",
  ".swift",
]);

const PRESENTATION_EXTS = new Set([".ppt", ".pptx", ".key", ".odp"]);

const TABLE_EXTS = new Set([".xls", ".xlsx", ".csv", ".numbers", ".ods", ".tsv"]);

const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".rtf", ".log"]);

export interface FileIconInput {
  readonly kind: EntryKind;
  readonly ext: string;
  readonly mime: string | null;
}

/**
 * Chooses which icon a file browser row should show. Extension-based
 * detection (code, archive, presentation, table, text) always takes
 * precedence over the server-provided `mime` guess, because a handful of
 * code extensions (notably `.ts`) collide with legacy media mime types
 * (`video/mp2t`); trusting the extension keeps those files showing a code
 * icon instead of a media one. Media (image/video/audio) is only decided
 * from `mime` once the extension is not recognized as one of those known
 * non-media kinds. Directories are always "folder".
 */
export function fileIconKind(entry: FileIconInput): FileIconKind {
  if (entry.kind === "dir") {
    return "folder";
  }

  const ext = entry.ext.toLowerCase();
  if (ARCHIVE_EXTS.has(ext)) {
    return "archive";
  }
  if (PRESENTATION_EXTS.has(ext)) {
    return "presentation";
  }
  if (TABLE_EXTS.has(ext)) {
    return "table";
  }
  if (CODE_EXTS.has(ext)) {
    return "code";
  }
  if (TEXT_EXTS.has(ext)) {
    return "text";
  }

  if (entry.mime !== null) {
    if (entry.mime.startsWith("image/")) {
      return "image";
    }
    if (entry.mime.startsWith("video/")) {
      return "video";
    }
    if (entry.mime.startsWith("audio/")) {
      return "audio";
    }
  }

  return "file";
}
