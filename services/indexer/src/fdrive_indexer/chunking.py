"""Text normalization, extension classification, and chunking. Pure string in,
string/list out; no filesystem or network access, ported faithfully from filesai.
"""

from __future__ import annotations

import re

PLAIN_EXTS = frozenset(
    {
        ".txt",
        ".md",
        ".markdown",
        ".csv",
        ".tsv",
        ".json",
        ".yaml",
        ".yml",
        ".xml",
        ".log",
        ".ini",
        ".cfg",
        ".conf",
        ".toml",
        ".tex",
        ".rst",
        ".org",
        ".srt",
        ".vtt",
        ".sh",
        ".zsh",
        ".bash",
        ".py",
        ".rb",
        ".php",
        ".pl",
        ".js",
        ".mjs",
        ".ts",
        ".tsx",
        ".jsx",
        ".java",
        ".kt",
        ".swift",
        ".m",
        ".mm",
        ".c",
        ".h",
        ".cpp",
        ".hpp",
        ".cc",
        ".cs",
        ".go",
        ".rs",
        ".sql",
        ".html",
        ".htm",
        ".css",
        ".scss",
        ".less",
        ".vue",
        ".svelte",
        ".env.example",
    }
)
PDF_EXTS = frozenset({".pdf"})
IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".gif", ".heic", ".heif"})
TIKA_EXTS = frozenset(
    {
        ".doc",
        ".docx",
        ".dot",
        ".dotx",
        ".xls",
        ".xlsx",
        ".xlsm",
        ".ppt",
        ".pptx",
        ".odt",
        ".ods",
        ".odp",
        ".rtf",
        ".epub",
        ".pages",
        ".numbers",
        ".key",
        ".eml",
        ".msg",
        ".vsd",
        ".vsdx",
        ".pub",
        ".wpd",
        ".mobi",
    }
)
TEXTUAL_EXTS = PLAIN_EXTS | PDF_EXTS | IMAGE_EXTS | TIKA_EXTS
SPREADSHEET_EXTS = frozenset({".xlsx", ".xlsm", ".xls", ".numbers", ".ods", ".csv", ".tsv"})

# Thumbnail-relevant extension groups (used by thumbs.py, kept alongside the other
# extension tables so one module owns "what kind of file is this").
VIDEO_EXTS = frozenset({".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"})

_ws = re.compile(r"[ \t\f\v]+")
_nl = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _ws.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _nl.sub("\n\n", text).strip()


def is_textual(ext: str) -> bool:
    return ext in TEXTUAL_EXTS


def is_pdf(ext: str) -> bool:
    return ext in PDF_EXTS


def is_image(ext: str) -> bool:
    return ext in IMAGE_EXTS


def is_plain(ext: str) -> bool:
    return ext in PLAIN_EXTS


def is_tika(ext: str) -> bool:
    return ext in TIKA_EXTS


def max_chunks_for(ext: str, default_max: int, spreadsheet_cap: int = 40) -> int:
    """Spreadsheets dump thousands of numbers; a few dozen chunks capture the labels
    that matter without drowning search results in numeric noise."""
    return min(default_max, spreadsheet_cap) if ext in SPREADSHEET_EXTS else default_max


def chunk(text: str, size: int, overlap: int, max_chunks: int) -> list[str]:
    """Sliding window over normalized text, breaking at whitespace where possible."""
    if len(text) <= size:
        return [text] if text else []
    out: list[str] = []
    start = 0
    n = len(text)
    while start < n and len(out) < max_chunks:
        end = min(start + size, n)
        if end < n:
            cut = max(text.rfind("\n", start + size - 300, end), text.rfind(" ", start + size - 300, end))
            if cut > start + size // 2:
                end = cut
        piece = text[start:end].strip()
        if piece:
            out.append(piece)
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return out
