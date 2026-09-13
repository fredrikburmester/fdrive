"""Thumbnail generation I/O: Pillow for images, pymupdf for PDF first pages, ffmpeg
for a video frame. Decisions (which kind, target sizes, whether to skip) live in the
pure `thumbs.py`; this module only touches disk and subprocesses. Failures are
logged and never raised, per the plan: one bad file must never fail the scan.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Callable

from .thumbs import SIZES, kind_for_ext, resize_dimensions, should_regenerate, skip_reason, storage_path


def _save_webp(image: object, dest: str, size: int) -> tuple[int, int]:
    from PIL import Image

    assert isinstance(image, Image.Image)
    w, h = resize_dimensions(image.width, image.height, size)
    resized = image.resize((w, h))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    resized.save(dest, "WEBP", quality=82)
    return w, h


def _open_image(abs_path: str) -> object:
    from PIL import Image, ImageOps

    from .heif import register_heif_opener

    register_heif_opener()
    opened = Image.open(abs_path)
    picture: Image.Image = ImageOps.exif_transpose(opened) or opened
    if picture.mode not in ("RGB", "RGBA"):
        picture = picture.convert("RGB")
    return picture


def _open_pdf_first_page(abs_path: str) -> object:
    import pymupdf
    from PIL import Image

    with pymupdf.open(abs_path) as doc:
        if doc.page_count == 0:  # pragma: no cover - pymupdf refuses to save a zero-page PDF
            raise ValueError("empty pdf")
        page = doc[0]
        pix = page.get_pixmap()
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _extract_video_frame(abs_path: str, at_seconds: float = 1.0) -> object:
    from PIL import Image

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                str(at_seconds),
                "-i",
                abs_path,
                "-frames:v",
                "1",
                "-vf",
                "thumbnail",
                tmp_path,
            ],
            check=True,
            capture_output=True,
            pass_fds=(int(abs_path.rsplit("/", 1)[1]),) if abs_path.startswith(("/proc/self/fd/", "/dev/fd/")) else (),
            timeout=60,
        )
        return Image.open(tmp_path).convert("RGB")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def generate(
    abs_path: str,
    ext: str,
    sha256: str,
    size_bytes: int,
    thumbs_dir: str,
    max_bytes: int,
    force: bool = False,
    exists: Callable[[str], bool] = os.path.exists,
    remove: Callable[[str], None] = os.remove,
    log: Callable[[str], None] = lambda _msg: None,
    on_error: Callable[[str], None] | None = None,
) -> list[tuple[int, str, int, int]]:
    """Generate the missing thumbnail sizes for one file. Returns
    `[(size, storage_path_relative, width, height), ...]` for every size that has a
    thumbnail on disk after the call, whether newly written or already present.

    With `force`, every size is deleted (if present) and rewritten, which is how
    the rebuild-thumbnails pass regenerates thumbnails that already exist; without
    it, an existing file for the same sha256 and size is left alone."""
    kind = kind_for_ext(ext)
    if kind is None:
        return []
    reason = skip_reason(size_bytes, max_bytes)
    if reason is not None:
        log(f"thumb: skip {abs_path}: {reason}")
        return []

    results: list[tuple[int, str, int, int]] = []
    try:
        image = None
        for size in SIZES:
            rel = storage_path(sha256, size)
            dest = os.path.join(thumbs_dir, rel)
            file_exists = exists(dest)
            if not should_regenerate(file_exists, force):
                from PIL import Image as PILImage

                with PILImage.open(dest) as existing:
                    results.append((size, rel, existing.width, existing.height))
                continue
            if file_exists:
                remove(dest)
            if image is None:
                if kind == "image":
                    image = _open_image(abs_path)
                elif kind == "pdf":
                    image = _open_pdf_first_page(abs_path)
                else:
                    image = _extract_video_frame(abs_path)
            w, h = _save_webp(image, dest, size)
            results.append((size, rel, w, h))
    except Exception as e:  # noqa: BLE001 - thumbnails never fail the file
        from .failures import describe

        reason = describe(e)
        log(f"thumb: failed for {abs_path} ({len(results)}/{len(SIZES)} sizes available): {reason}")
        if on_error is not None:
            on_error(reason)
        return results
    return results
