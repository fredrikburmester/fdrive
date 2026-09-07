"""Bounded, descriptor-relative directory metadata for internal scope verification."""

from __future__ import annotations

import os
import unicodedata
from collections.abc import Sequence
from typing import Literal, TypedDict

MAX_ENTRIES = 10000


class DirectoryEntry(TypedDict):
    name: str
    kind: Literal["file", "dir", "symlink", "other"]


class DirectoryListing(TypedDict):
    items: list[DirectoryEntry]
    overflow: bool


def directory_parts(path: str) -> list[str]:
    """Accept a canonical root-relative path, already decoded once by HTTP."""
    if not path.startswith("/") or len(path) > 4096 or "\\" in path or any(unicodedata.category(char) == "Cc" for char in path):
        raise ValueError("invalid path")
    if path == "/":
        return []
    parts = path[1:].split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("invalid path")
    return parts


def directory_query(fields: Sequence[tuple[str, str]]) -> tuple[str, str]:
    """Reject missing, duplicate and unknown query fields without another decode."""
    if len(fields) != 2 or {key for key, _ in fields} != {"root", "path"}:
        raise ValueError("root and path are required")
    query = dict(fields)
    root, path = query["root"], query["path"]
    if not root or len(root) > 255 or any(unicodedata.category(char) == "Cc" for char in root):
        raise ValueError("invalid root")
    directory_parts(path)
    return root, path


def list_directory(root: str, path: str) -> DirectoryListing:
    """Walk only directory descriptors; descendant symlinks are never followed."""
    parts = directory_parts(path)
    # The root is operator-configured and trusted, including its own symlink target.
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        items: list[DirectoryEntry] = []
        overflow = False
        with os.scandir(descriptor) as entries:
            for entry in entries:
                if len(items) == MAX_ENTRIES:
                    overflow = True
                    break
                kind: Literal["file", "dir", "symlink", "other"] = "other"
                if entry.is_symlink():
                    kind = "symlink"
                elif entry.is_dir(follow_symlinks=False):
                    kind = "dir"
                elif entry.is_file(follow_symlinks=False):
                    kind = "file"
                items.append({"name": entry.name, "kind": kind})
        items.sort(key=lambda entry: entry["name"])
        return {"items": items, "overflow": overflow}
    finally:
        os.close(descriptor)
