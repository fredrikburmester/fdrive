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
from typing import TYPE_CHECKING

from .thumbs import SIZES, kind_for_ext, resize_dimensions, should_regenerate, skip_reason, storage_path

if TYPE_CHECKING:
    from PIL import ImageFile


class NoThumbnail(Exception):
    """The source was read and has nothing to render, such as a video without a picture."""


def _fit(image: object, size: int) -> object:
    """`image` scaled down so its longest side is at most `size`; unchanged when it fits."""
    from PIL import Image

    assert isinstance(image, Image.Image)
    w, h = resize_dimensions(image.width, image.height, size)
    # A reducing gap shrinks by an integer factor before resampling: faster on
    # camera-sized sources and visually identical at thumbnail sizes.
    return image if (w, h) == image.size else image.resize((w, h), reducing_gap=3.0)


def _save_webp(image: object, dest: str, size: int) -> tuple[int, int]:
    from PIL import Image

    resized = _fit(image, size)
    assert isinstance(resized, Image.Image)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    resized.save(dest, "WEBP", quality=82)
    return resized.width, resized.height


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


def _open_image(abs_path: str, longest_side: int | None = None) -> object:
    from PIL import Image, ImageOps

    from .heif import register_heif_opener
    from .png import allow_large_png_metadata

    register_heif_opener()
    allow_large_png_metadata()
    try:
        opened = Image.open(abs_path)
    except Image.DecompressionBombError:
        reduced = _open_reduced_jpeg(abs_path)
        if reduced is None:
            raise
        opened = reduced
    if longest_side is not None:
        # JPEG decodes at 1/2, 1/4 or 1/8 scale when that still covers the target,
        # which skips most of the decoding work. Other formats, and a JPEG already
        # reduced above, ignore the hint.
        opened.draft(None, resize_dimensions(opened.width, opened.height, longest_side))
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


_VIDEO_FRAME_FILTER = (
    f"thumbnail,scale=w='min(iw,{max(SIZES)})':h='min(ih,{max(SIZES)})':force_original_aspect_ratio=decrease"
)


def _write_video_frame(abs_path: str, dest: str, at_seconds: float) -> None:
    try:
        _run_media_tool(
            abs_path,
            # Pick the frame first, then shrink it so a 4K frame is never encoded and
            # decoded again as a full-size PNG.
            ["ffmpeg", "-y", "-ss", str(at_seconds), "-i", abs_path, "-frames:v", "1", "-vf", _VIDEO_FRAME_FILTER, dest],
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
        present = {size: exists(os.path.join(thumbs_dir, storage_path(sha256, size))) for size in SIZES}
        largest = max((size for size in SIZES if should_regenerate(present[size], force)), default=None)
        image = None
        for size in SIZES:
            rel = storage_path(sha256, size)
            dest = os.path.join(thumbs_dir, rel)
            if not should_regenerate(present[size], force):
                from PIL import Image as PILImage

                with PILImage.open(dest) as existing:
                    results.append((size, rel, existing.width, existing.height))
                continue
            if present[size]:
                remove(dest)
            if image is None:
                assert largest is not None  # this size needs regenerating
                if kind == "image":
                    source = _open_image(abs_path, largest)
                elif kind == "pdf":
                    source = _open_pdf_first_page(abs_path)
                else:
                    source = _extract_video_frame(abs_path)
                # Scale once to the largest size needed; smaller sizes derive from that
                # instead of resampling the full-resolution source again.
                image = _fit(source, largest)
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
