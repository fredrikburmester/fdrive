"""Pure decisions about whether a path is worth walking, watching, or extracting.

Prefix rules (legacy, comma-separated env config) and glob rules (settings, matched
with fnmatch against `<root>/<rel>`) are both expressed here as pure predicates.
"""

from __future__ import annotations

from fnmatch import fnmatch

from .paths import root_relative_key


def split_prefixes(raw: str) -> list[str]:
    """`"Photos, Videos/Raw,,"` -> `["Photos", "Videos/Raw"]`."""
    return [p.strip().strip("/") for p in raw.split(",") if p.strip()]


def under_prefix(rel_path: str, prefixes: list[str]) -> bool:
    return any(rel_path == p or rel_path.startswith(p + "/") for p in prefixes)


def matches_any_glob(key: str, globs: list[str]) -> bool:
    return any(fnmatch(key, pattern) for pattern in globs)


def is_text_excluded(root: str, rel_path: str, globs: list[str]) -> bool:
    return matches_any_glob(root_relative_key(root, rel_path), globs)


def is_ocr_image_dir(root: str, rel_path: str, globs: list[str]) -> bool:
    return matches_any_glob(root_relative_key(root, rel_path), globs)


def should_walk_dir(name: str, skip_dirs: frozenset[str]) -> bool:
    return name not in skip_dirs


def should_index_name(name: str, skip_names: frozenset[str]) -> bool:
    return not (name.startswith("._") or name in skip_names)
