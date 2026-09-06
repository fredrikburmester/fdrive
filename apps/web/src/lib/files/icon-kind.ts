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
 * Chooses which icon a file browser row should show, preferring the
 * server-provided `mime` guess for images/video/audio and falling back to
 * the file extension for everything else. Directories are always "folder".
 */
export function fileIconKind(entry: FileIconInput): FileIconKind {
  if (entry.kind === "dir") {
    return "folder";
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

  return "file";
}
