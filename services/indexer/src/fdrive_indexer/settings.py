"""Parsing of the `app.settings` rows the indexer reads at the start of each scan
cycle, with fallback to env-derived defaults and change detection for logging.

Pure: takes a `dict[str, object]` of already-fetched raw values (as `db.py` decodes
them from jsonb) and a `Settings` of defaults, returns a resolved `Settings` plus the
list of keys that changed since the previous cycle.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, fields

SCAN_INTERVAL_KEY = "indexer.scan_interval_seconds"
WORKERS_KEY = "indexer.workers"
TEXT_EXCLUDE_GLOBS_KEY = "indexer.text_exclude_globs"
OCR_IMAGE_GLOBS_KEY = "indexer.ocr_image_globs"
TESSERACT_LANGS_KEY = "indexer.tesseract_langs"


@dataclass(frozen=True)
class Settings:
    scan_interval_seconds: int
    workers: int
    text_exclude_globs: tuple[str, ...]
    ocr_image_globs: tuple[str, ...]
    tesseract_langs: str


def _decode(value: object) -> object:
    """`app.settings.value` is jsonb; a driver that returns it as text needs one
    `json.loads`, a driver that already decodes it can pass the value through."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _parse_int(raw: object, default: int) -> int:
    value = _decode(raw)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return default


def _parse_glob_list(raw: object, default: tuple[str, ...]) -> tuple[str, ...]:
    value = _decode(raw)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return tuple(value)
    return default


def _parse_str(raw: object, default: str) -> str:
    value = _decode(raw)
    if isinstance(value, str) and value.strip():
        return value
    return default


def resolve_settings(raw: dict[str, object], defaults: Settings) -> Settings:
    return Settings(
        scan_interval_seconds=_parse_int(raw.get(SCAN_INTERVAL_KEY), defaults.scan_interval_seconds),
        workers=_parse_int(raw.get(WORKERS_KEY), defaults.workers),
        text_exclude_globs=_parse_glob_list(raw.get(TEXT_EXCLUDE_GLOBS_KEY), defaults.text_exclude_globs),
        ocr_image_globs=_parse_glob_list(raw.get(OCR_IMAGE_GLOBS_KEY), defaults.ocr_image_globs),
        tesseract_langs=_parse_str(raw.get(TESSERACT_LANGS_KEY), defaults.tesseract_langs),
    )


def diff_changed(old: Settings, new: Settings) -> list[str]:
    """Field names whose resolved value changed between two cycles, for logging."""
    return [f.name for f in fields(Settings) if getattr(old, f.name) != getattr(new, f.name)]
