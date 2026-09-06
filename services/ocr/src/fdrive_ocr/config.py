"""Environment-derived configuration. Reading `os.environ` is I/O by nature, so
this module is a thin, mostly untested shim; the parsing it delegates to lives
in `settings.py` and is fully unit tested there.
"""

from __future__ import annotations

import os

from .settings import Settings


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def parse_roots(raw: str) -> dict[str, str]:
    """`"sftpgo=/roots/sftpgo,photos=/roots/photos"` -> `{"sftpgo": "/roots/sftpgo", ...}`.
    Same format as the indexer's `INDEX_ROOTS`."""
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
        self.tz_name = os.environ.get("TZ", "UTC")
        self.ocr_port = int(os.environ.get("OCR_PORT", "8011"))
        self.state_dir = os.environ.get("STATE_DIR", "/state")
        self.run_on_start = _bool("OCR_RUN_ON_START", True)
        self.timeout_seconds = int(os.environ.get("OCR_TIMEOUT_SECONDS", "900"))
        self.jobs = int(os.environ.get("OCR_JOBS", "2"))
        self.schema_wait_seconds = int(os.environ.get("SCHEMA_WAIT_SECONDS", "300"))
        self.default_hour = int(os.environ.get("OCR_HOUR", "3"))
        self.default_langs = os.environ.get("OCR_LANGS", "swe+eng")
        self.default_exclude_globs = tuple(
            g.strip() for g in os.environ.get("OCR_EXCLUDE_GLOBS", "Programs/**,Photos/**,Videos/**").split(",") if g.strip()
        )
        self.default_max_mb = int(os.environ.get("OCR_MAX_MB", "200"))
        self.default_keep_originals = _bool("OCR_KEEP_ORIGINALS", True)

    def default_settings(self) -> Settings:
        return Settings(
            hour=self.default_hour,
            langs=self.default_langs,
            exclude_globs=self.default_exclude_globs,
            max_mb=self.default_max_mb,
            keep_originals=self.default_keep_originals,
        )
