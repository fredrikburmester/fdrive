"""Thumbnail decision logic: what kind of thumbnail (if any) a file gets, where it is
stored, and what its resized dimensions are. No image, PDF, or video library is
imported here; the actual generation lives in `thumbs_io.py`.
"""

from __future__ import annotations

from typing import Literal

from .chunking import IMAGE_EXTS, PDF_EXTS, VIDEO_EXTS

ThumbKind = Literal["image", "pdf", "video"]
SIZES: tuple[int, int] = (256, 1024)


def kind_for_ext(ext: str) -> ThumbKind | None:
    if ext in IMAGE_EXTS:
        return "image"
    if ext in PDF_EXTS:
        return "pdf"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def within_size_budget(size_bytes: int, max_bytes: int) -> bool:
    return size_bytes <= max_bytes


def storage_path(sha256: str, size: int) -> str:
    """Path relative to `THUMBS_DIR`: `<sha[:2]>/<sha>.<size>.webp`."""
    return f"{sha256[:2]}/{sha256}.{size}.webp"


def resize_dimensions(width: int, height: int, target_longest_side: int) -> tuple[int, int]:
    """New (width, height) with the longest side equal to `target_longest_side`,
    preserving aspect ratio. Never upscales past the target; a source smaller than
    the target keeps its own size (still capped so we never round to 0)."""
    if width <= 0 or height <= 0:
        return max(width, 1), max(height, 1)
    longest = max(width, height)
    if longest <= target_longest_side:
        return width, height
    scale = target_longest_side / longest
    new_w = max(round(width * scale), 1)
    new_h = max(round(height * scale), 1)
    return new_w, new_h


def should_skip_existing(exists: bool) -> bool:
    """Thumbnails are content-addressed by sha256, so an existing file for the same
    sha and size never needs regenerating."""
    return exists
