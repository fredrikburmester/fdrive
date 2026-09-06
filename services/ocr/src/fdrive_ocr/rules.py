"""Pure decisions about whether a candidate PDF is worth attempting: exclude
globs (matched with `fnmatch` against `<root>/<rel>`, same convention as the
indexer's `rules.py`), the size cap, and filename filters.
"""

from __future__ import annotations

from fnmatch import fnmatch

BYTES_PER_MB = 1024 * 1024


def root_relative_key(root: str, rel_path: str) -> str:
    return f"{root}/{rel_path}"


def is_excluded(root: str, rel_path: str, globs: list[str]) -> bool:
    key = root_relative_key(root, rel_path)
    return any(fnmatch(key, pattern) for pattern in globs)


def is_too_big(size_bytes: int, max_mb: int) -> bool:
    return size_bytes > max_mb * BYTES_PER_MB


def is_candidate_pdf(name: str) -> bool:
    """A regular PDF, skipping AppleDouble sidecar files (`._report.pdf`)."""
    return name.lower().endswith(".pdf") and not name.startswith("._")
