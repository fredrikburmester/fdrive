"""Environment-derived configuration. Reading `os.environ` is I/O by nature, so this
module is a thin, mostly untested shim; the parsing it delegates to lives in
`settings.py` and `rules.py` and is fully unit tested there.
"""

from __future__ import annotations

import os

from .rules import split_prefixes
from .settings import Settings


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def parse_roots(raw: str) -> dict[str, str]:
    """`"sftpgo=/roots/sftpgo,photos=/roots/photos"` -> `{"sftpgo": "/roots/sftpgo", ...}`."""
    roots: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        name, _, path = pair.partition("=")
        name, path = name.strip(), path.strip()
        if name and path:
            roots[name] = path
    return roots


class Config:
    def __init__(self) -> None:
        self.database_url = os.environ.get("DATABASE_URL", "postgres://fdrive:fdrive@db:5432/fdrive")
        self.roots = parse_roots(os.environ.get("INDEX_ROOTS", ""))
        self.tika_url = os.environ.get("TIKA_URL", "http://tika:9998").rstrip("/")
        self.embed_url = os.environ.get("EMBED_URL", "http://embed:80").rstrip("/")
        self.embed_dim = int(os.environ.get("EMBED_DIM", "384"))
        self.embed_batch = int(os.environ.get("EMBED_BATCH", "16"))
        self.scan_interval = int(os.environ.get("SCAN_INTERVAL_SECONDS", "900"))
        self.text_max_bytes = int(os.environ.get("TEXT_MAX_MB", "64")) * 1024 * 1024
        self.image_max_bytes = int(os.environ.get("IMAGE_MAX_MB", "25")) * 1024 * 1024
        self.plain_text_cap = int(os.environ.get("PLAIN_TEXT_CAP", "300000"))
        self.max_pdf_pages = int(os.environ.get("MAX_PDF_PAGES", "600"))
        self.max_chunks_per_file = int(os.environ.get("MAX_CHUNKS_PER_FILE", "400"))
        self.chunk_chars = int(os.environ.get("CHUNK_CHARS", "1200"))
        self.chunk_overlap = int(os.environ.get("CHUNK_OVERLAP", "200"))
        self.text_exclude_globs = split_prefixes(os.environ.get("TEXT_EXCLUDE_GLOBS", ""))
        self.ocr_image_globs = split_prefixes(os.environ.get("OCR_IMAGE_GLOBS", ""))
        self.tesseract_langs = os.environ.get("TESSERACT_LANGS", "swe+eng")
        self.skip_names = frozenset({".DS_Store", "Thumbs.db", "desktop.ini", ".localized"})
        self.skip_dirs = frozenset({"@eaDir", ".Trash", ".Trashes", "node_modules", ".git"})
        self.watch = _bool("WATCH", True)
        self.watch_debounce = float(os.environ.get("WATCH_DEBOUNCE_SECONDS", "2"))
        self.workers = int(os.environ.get("INDEX_WORKERS", "4"))
        self.thumbs_dir = os.environ.get("THUMBS_DIR", "/thumbs")
        self.thumb_max_bytes = int(os.environ.get("THUMB_MAX_MB", "200")) * 1024 * 1024
        self.indexer_port = int(os.environ.get("INDEXER_PORT", "8010"))
        self.schema_wait_seconds = int(os.environ.get("SCHEMA_WAIT_SECONDS", "300"))
        self.events_retention_days = int(os.environ.get("EVENTS_RETENTION_DAYS", "7"))

    def default_settings(self) -> Settings:
        return Settings(
            scan_interval_seconds=self.scan_interval,
            workers=self.workers,
            text_exclude_globs=tuple(self.text_exclude_globs),
            ocr_image_globs=tuple(self.ocr_image_globs),
            tesseract_langs=self.tesseract_langs,
        )
