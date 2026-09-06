"""Parsing of the `app.settings` rows this service reads before every nightly
(or manually triggered) pass, with fallback to env-derived defaults and change
detection for logging. Mirrors the indexer's `settings.py` conventions.

Pure: takes a `dict[str, object]` of already-fetched raw values (as `db.py`
decodes them from jsonb) and a `Settings` of defaults, returns a resolved
`Settings` plus the list of keys that changed since the previous cycle.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, fields

HOUR_KEY = "ocr.hour"
LANGS_KEY = "ocr.langs"
EXCLUDE_GLOBS_KEY = "ocr.exclude_globs"
MAX_MB_KEY = "ocr.max_mb"
KEEP_ORIGINALS_KEY = "ocr.keep_originals"

MIN_HOUR = 0
MAX_HOUR = 23

DEFAULT_HOUR = 3
DEFAULT_LANGS = "swe+eng"
DEFAULT_EXCLUDE_GLOBS: tuple[str, ...] = ("Programs/**", "Photos/**", "Videos/**")
DEFAULT_MAX_MB = 200
DEFAULT_KEEP_ORIGINALS = True


@dataclass(frozen=True)
class Settings:
    hour: int
    langs: str
    exclude_globs: tuple[str, ...]
    max_mb: int
    keep_originals: bool


def default_settings() -> Settings:
    return Settings(
        hour=DEFAULT_HOUR,
        langs=DEFAULT_LANGS,
        exclude_globs=DEFAULT_EXCLUDE_GLOBS,
        max_mb=DEFAULT_MAX_MB,
        keep_originals=DEFAULT_KEEP_ORIGINALS,
    )


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


def _parse_hour(raw: object, default: int) -> int:
    value = _parse_int(raw, default)
    if MIN_HOUR <= value <= MAX_HOUR:
        return value
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


def _parse_bool(raw: object, default: bool) -> bool:
    value = _decode(raw)
    if isinstance(value, bool):
        return value
    # `_decode` runs a JSON-string value through `json.loads`, so a raw "0" or
    # "1" comes back as an `int`, not a `str`; handle that before the string
    # branch below, which only ever sees non-numeric spellings like "yes".
    if isinstance(value, int):
        return {0: False, 1: True}.get(value, default)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    return default


def resolve_settings(raw: dict[str, object], defaults: Settings) -> Settings:
    return Settings(
        hour=_parse_hour(raw.get(HOUR_KEY), defaults.hour),
        langs=_parse_str(raw.get(LANGS_KEY), defaults.langs),
        exclude_globs=_parse_glob_list(raw.get(EXCLUDE_GLOBS_KEY), defaults.exclude_globs),
        max_mb=_parse_int(raw.get(MAX_MB_KEY), defaults.max_mb),
        keep_originals=_parse_bool(raw.get(KEEP_ORIGINALS_KEY), defaults.keep_originals),
    )


def diff_changed(old: Settings, new: Settings) -> list[str]:
    """Field names whose resolved value changed between two cycles, for logging."""
    return [f.name for f in fields(Settings) if getattr(old, f.name) != getattr(new, f.name)]
