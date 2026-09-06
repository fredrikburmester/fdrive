"""Pure path helpers. No filesystem access: every function takes strings in, returns
strings or booleans out, so it is trivially testable without a real directory tree.
"""

from __future__ import annotations

import posixpath


def ext_of(name: str) -> str:
    """Lowercase extension, with the leading dot. `.tar.gz` is treated as one extension."""
    lower = name.lower()
    if lower.endswith(".tar.gz"):
        return ".tar.gz"
    _, ext = posixpath.splitext(lower)
    return ext


def is_junk_name(name: str, skip_names: frozenset[str]) -> bool:
    """AppleDouble sidecar files and OS junk files that are never worth indexing."""
    return name.startswith("._") or name in skip_names


def is_skip_dir(name: str, skip_dirs: frozenset[str]) -> bool:
    return name in skip_dirs


def root_relative_key(root: str, rel_path: str) -> str:
    """The `<root>/<rel>` key that settings-based glob rules match against."""
    return f"{root}/{rel_path}"


def parent_dir(rel_path: str) -> str:
    """Parent of a root-relative path, `""` for a top-level entry."""
    head, _, _tail = rel_path.rpartition("/")
    return head


def is_under(rel_path: str, prefix_rel_path: str) -> bool:
    """True when `rel_path` is `prefix_rel_path` itself or lives below it."""
    if prefix_rel_path == "":
        return True
    return rel_path == prefix_rel_path or rel_path.startswith(prefix_rel_path + "/")


def reindex_scope(path: str | None) -> tuple[str | None, str | None]:
    """Split a `/reindex` request path into (exact_path, subtree_prefix).

    `path=None` means the whole root: both are `None`. Otherwise both the exact
    path and its `path/` prefix are returned so the caller can match either a
    single file or every row below a directory in one query.
    """
    if path is None:
        return None, None
    normalized = path.strip("/")
    return normalized, normalized + "/"
