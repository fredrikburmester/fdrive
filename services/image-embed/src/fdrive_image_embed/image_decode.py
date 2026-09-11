"""Bounded Pillow image decoding without importing Pillow in the test runtime."""

from __future__ import annotations

from io import BytesIO
from typing import Any, Protocol

from .embedder import ImageDecodeError

# SigLIP consumes 256 px inputs and the indexer sends 256 px thumbnails. This
# still permits large originals while bounding one RGB conversion to about
# 48 MiB (and one configured inference batch to about 384 MiB).
MAX_IMAGE_PIXELS = 4096 * 4096


class OpenedImage(Protocol):
    size: tuple[int, int]

    def convert(self, mode: str) -> Any: ...  # pragma: no cover

    def close(self) -> None: ...  # pragma: no cover


class ImageOpener(Protocol):
    def __call__(self, stream: BytesIO, /) -> OpenedImage: ...  # pragma: no cover


def decode_rgb_image(raw: bytes, open_image: ImageOpener) -> Any:
    """Open image headers, reject excessive dimensions, then allocate RGB pixels."""
    try:
        source = open_image(BytesIO(raw))
        try:
            width, height = source.size
            pixels = width * height
            if pixels > MAX_IMAGE_PIXELS:
                raise ImageDecodeError(f"image has {pixels} pixels; maximum is {MAX_IMAGE_PIXELS}")
            return source.convert("RGB")
        finally:
            source.close()
    except ImageDecodeError:
        raise
    except Exception as e:
        raise ImageDecodeError(str(e)) from e
