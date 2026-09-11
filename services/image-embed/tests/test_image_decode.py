from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest

from fdrive_image_embed.embedder import ImageDecodeError
from fdrive_image_embed.image_decode import MAX_IMAGE_PIXELS, decode_rgb_image


class FakeOpenedImage:
    def __init__(self, size: tuple[int, int], converted: object = None, convert_error: Exception | None = None) -> None:
        self.size = size
        self.converted = converted
        self.convert_error = convert_error
        self.convert_calls: list[str] = []
        self.closed = False

    def convert(self, mode: str) -> Any:
        self.convert_calls.append(mode)
        if self.convert_error is not None:
            raise self.convert_error
        return self.converted

    def close(self) -> None:
        self.closed = True


def test_decode_rgb_image_checks_dimensions_before_conversion() -> None:
    source = FakeOpenedImage((MAX_IMAGE_PIXELS + 1, 1))

    with pytest.raises(ImageDecodeError, match=rf"maximum is {MAX_IMAGE_PIXELS}"):
        decode_rgb_image(b"compressed", lambda _stream: source)

    assert source.convert_calls == []
    assert source.closed is True


def test_decode_rgb_image_opens_bytes_and_converts_ordinary_image() -> None:
    converted = object()
    source = FakeOpenedImage((256, 192), converted)
    opened: list[bytes] = []

    def open_image(stream: BytesIO) -> FakeOpenedImage:
        opened.append(stream.read())
        return source

    assert decode_rgb_image(b"ordinary-image", open_image) is converted
    assert opened == [b"ordinary-image"]
    assert source.convert_calls == ["RGB"]
    assert source.closed is True


def test_decode_rgb_image_accepts_exact_pixel_limit() -> None:
    source = FakeOpenedImage((4096, 4096), object())

    decode_rgb_image(b"image", lambda _stream: source)

    assert source.convert_calls == ["RGB"]


def test_decode_rgb_image_wraps_open_failure() -> None:
    def fail_open(_stream: BytesIO) -> FakeOpenedImage:
        raise OSError("bad header")

    with pytest.raises(ImageDecodeError, match="bad header"):
        decode_rgb_image(b"bad", fail_open)


def test_decode_rgb_image_wraps_conversion_failure_and_closes_source() -> None:
    source = FakeOpenedImage((64, 64), convert_error=OSError("truncated pixels"))

    with pytest.raises(ImageDecodeError, match="truncated pixels"):
        decode_rgb_image(b"truncated", lambda _stream: source)

    assert source.closed is True
