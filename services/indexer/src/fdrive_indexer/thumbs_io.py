"""Thumbnail generation I/O: Pillow for images, pymupdf for PDF first pages, ffmpeg
for a video frame. Decisions (which kind, target sizes, whether to skip) live in the
pure `thumbs.py`; this module only touches disk and subprocesses. Failures are
logged and never raised, per the plan: one bad file must never fail the scan.
"""

from __future__ import annotations

import functools
import os
import subprocess
import tempfile
from collections.abc import Callable
from typing import TYPE_CHECKING

from .thumbs import SIZES, kind_for_ext, resize_dimensions, should_regenerate, skip_reason, storage_path

if TYPE_CHECKING:
    from PIL import ImageFile


class NoThumbnail(Exception):
    """The source was read and has nothing to render, such as a video without a picture."""


def _save_webp(image: object, dest: str, size: int) -> tuple[int, int]:
    from PIL import Image

    assert isinstance(image, Image.Image)
    w, h = resize_dimensions(image.width, image.height, size)
    resized = image.resize((w, h))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    resized.save(dest, "WEBP", quality=82)
    return w, h


@functools.cache
def _allow_large_png_metadata() -> None:
    """Pillow rejects a PNG whose compressed text or ICC chunk inflates past 1 MiB, which
    ordinary files in real libraries exceed. Each chunk stays capped at the 64 MiB Pillow
    already allows for all of a file's text together."""
    from PIL import PngImagePlugin

    PngImagePlugin.MAX_TEXT_CHUNK = PngImagePlugin.MAX_TEXT_MEMORY


def _open_reduced_jpeg(abs_path: str) -> ImageFile.ImageFile | None:
    """Pillow refuses sources over its pixel limit while opening, before a JPEG can be told
    to decode at a reduced DCT scale, so camera panoramas fail. Reopen a JPEG directly,
    draft it to twice the largest thumbnail (as `Image.thumbnail` does) and apply the same
    limit to the drafted size. None when the source is not a JPEG or is still too large."""
    from PIL import Image, JpegImagePlugin

    with open(abs_path, "rb") as stream:
        if stream.read(3) != b"\xff\xd8\xff":
            return None
    picture = JpegImagePlugin.JpegImageFile(abs_path)
    width, height = resize_dimensions(picture.width, picture.height, max(SIZES))
    picture.draft(None, (width * 2, height * 2))
    if Image.MAX_IMAGE_PIXELS is not None and picture.width * picture.height > 2 * Image.MAX_IMAGE_PIXELS:
        picture.close()
        return None
    return picture


def _open_image(abs_path: str) -> object:
    from PIL import Image, ImageOps

    from .heif import register_heif_opener

    register_heif_opener()
    _allow_large_png_metadata()
    try:
        opened = Image.open(abs_path)
    except Image.DecompressionBombError:
        reduced = _open_reduced_jpeg(abs_path)
        if reduced is None:
            raise
        opened = reduced
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


def _run_media_tool(abs_path: str, cmd: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        cmd,
        check=True,
        capture_output=True,
        pass_fds=(int(abs_path.rsplit("/", 1)[1]),) if abs_path.startswith(("/proc/self/fd/", "/dev/fd/")) else (),
        timeout=60,
    )


def _has_video_stream(abs_path: str) -> bool | None:
    """Whether ffprobe finds a video stream; None when it cannot read the container either."""
    try:
        probe = _run_media_tool(
            abs_path,
            ["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", abs_path],
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return bool(probe.stdout.strip())


def _write_video_frame(abs_path: str, dest: str, at_seconds: float) -> None:
    try:
        _run_media_tool(
            abs_path,
            ["ffmpeg", "-y", "-ss", str(at_seconds), "-i", abs_path, "-frames:v", "1", "-vf", "thumbnail", dest],
        )
    except subprocess.CalledProcessError:
        if _has_video_stream(abs_path) is False:
            raise NoThumbnail("no video stream") from None
        raise


def _extract_video_frame(abs_path: str, at_seconds: float = 1.0) -> object:
    from PIL import Image

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        _write_video_frame(abs_path, tmp_path, at_seconds)
        if os.path.getsize(tmp_path) == 0 and at_seconds > 0:
            # ffmpeg exits successfully without writing a frame when a clip ends before the seek point.
            _write_video_frame(abs_path, tmp_path, 0.0)
        if os.path.getsize(tmp_path) == 0:
            raise ValueError("ffmpeg wrote no video frame")
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
    on_skip: Callable[[str], None] | None = None,
) -> list[tuple[int, str, int, int]]:
    """Generate the missing thumbnail sizes for one file. Returns
    `[(size, storage_path_relative, width, height), ...]` for every size that has a
    thumbnail on disk after the call, whether newly written or already present.

    With `force`, every size is deleted (if present) and rewritten, which is how
    the rebuild-thumbnails pass regenerates thumbnails that already exist; without
    it, an existing file for the same sha256 and size is left alone.

    `on_skip` receives the reason when the source was read and has nothing to render."""
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
    except NoThumbnail as e:
        log(f"thumb: skip {abs_path}: {e}")
        if on_skip is not None:
            on_skip(str(e))
        return results
    except Exception as e:  # noqa: BLE001 - thumbnails never fail the file
        from .failures import describe

        reason = describe(e)
        log(f"thumb: failed for {abs_path} ({len(results)}/{len(SIZES)} sizes available): {reason}")
        if on_error is not None:
            on_error(reason)
        return results
    return results
