from __future__ import annotations

import io
import sys
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from fdrive_indexer import raw as raw_module
from fdrive_indexer import thumbs_io
from fdrive_indexer.chunking import RAW_EXTS, is_image, is_textual
from fdrive_indexer.thumbs import kind_for_ext


class _NoThumbnail(Exception):
    pass


class _UnsupportedThumbnail(Exception):
    pass


class _Thumb:
    def __init__(self, fmt: str, data: Any) -> None:
        self.format = fmt
        self.data = data


class _FakeRaw:
    """Stands in for `rawpy.RawPy`: a canned thumbnail (or error) and a canned development."""

    def __init__(self, thumb: _Thumb | Exception | None, flip: int = 0, develop: Callable[[], Any] | None = None) -> None:
        self._thumb = thumb
        self.sizes = types.SimpleNamespace(flip=flip)
        self._develop = develop
        self.postprocess_calls: list[dict[str, Any]] = []

    def __enter__(self) -> _FakeRaw:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def extract_thumb(self) -> _Thumb:
        if isinstance(self._thumb, Exception):
            raise self._thumb
        assert self._thumb is not None
        return self._thumb

    def postprocess(self, **kw: Any) -> Any:
        self.postprocess_calls.append(kw)
        if self._develop is None:
            raise RuntimeError("cannot develop")
        return self._develop()


def _install_fake_rawpy(monkeypatch: pytest.MonkeyPatch, raw: _FakeRaw) -> None:
    fake = types.ModuleType("rawpy")
    fake.LibRawNoThumbnailError = _NoThumbnail  # type: ignore[attr-defined]
    fake.LibRawUnsupportedThumbnailError = _UnsupportedThumbnail  # type: ignore[attr-defined]
    fake.ThumbFormat = types.SimpleNamespace(JPEG="jpeg", BITMAP="bitmap")  # type: ignore[attr-defined]
    fake.imread = lambda _path: raw  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "rawpy", fake)


def _jpeg_bytes(size: tuple[int, int], color: str, orientation: int | None = None) -> bytes:
    buffer = io.BytesIO()
    kwargs: dict[str, Any] = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[raw_module.EXIF_ORIENTATION] = orientation
        kwargs["exif"] = exif
    Image.new("RGB", size, color=color).save(buffer, "JPEG", **kwargs)
    return buffer.getvalue()


def _two_tone(size: tuple[int, int]) -> Image.Image:
    """Left half red, right half blue, so a rotation is observable."""
    image = Image.new("RGB", size, color="red")
    image.paste("blue", (size[0] // 2, 0, size[0], size[1]))
    return image


def test_raw_extensions_are_thumbnail_images_but_never_text() -> None:
    for ext in RAW_EXTS:
        assert kind_for_ext(ext) == "image"
        assert not is_image(ext)
        assert not is_textual(ext)
    assert ".arw" in RAW_EXTS


@pytest.mark.parametrize(
    ("flip", "top_left"),
    [(0, "red"), (3, "blue"), (5, "blue"), (6, "red")],
)
def test_apply_flip_turns_libraw_orientations_upright(flip: int, top_left: str) -> None:
    turned = raw_module.apply_flip(_two_tone((20, 10)), flip)
    expected = {"red": (255, 0, 0), "blue": (0, 0, 255)}[top_left]
    assert turned.getpixel((0, 0)) == expected
    assert turned.size == ((20, 10) if flip in (0, 3) else (10, 20))


def test_apply_flip_ignores_unknown_codes() -> None:
    image = _two_tone((20, 10))
    assert raw_module.apply_flip(image, 7) is image


def test_has_exif_orientation_only_for_rotated_tags() -> None:
    upright = Image.open(io.BytesIO(_jpeg_bytes((8, 8), "red", orientation=1)))
    rotated = Image.open(io.BytesIO(_jpeg_bytes((8, 8), "red", orientation=6)))
    plain = Image.open(io.BytesIO(_jpeg_bytes((8, 8), "red")))
    assert not raw_module.has_exif_orientation(upright)
    assert raw_module.has_exif_orientation(rotated)
    assert not raw_module.has_exif_orientation(plain)


def test_has_exif_orientation_treats_broken_exif_as_none() -> None:
    class Broken:
        def getexif(self) -> Any:
            raise ValueError("bad exif")

    assert not raw_module.has_exif_orientation(Broken())  # type: ignore[arg-type]


def test_preview_covers_target_size() -> None:
    assert raw_module.preview_covers(1616, 1080, 1024)
    assert raw_module.preview_covers(1024, 683, 1024)
    assert not raw_module.preview_covers(160, 120, 1024)
    assert raw_module.preview_covers(160, 120, None)


def test_open_raw_uses_embedded_jpeg_preview_and_libraw_flip(monkeypatch: pytest.MonkeyPatch) -> None:
    buffer = io.BytesIO()
    _two_tone((1600, 1000)).save(buffer, "JPEG")
    fake = _FakeRaw(_Thumb("jpeg", buffer.getvalue()), flip=6)
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (1000, 1600)
    assert picture.mode == "RGB"
    assert fake.postprocess_calls == []


def test_open_raw_prefers_the_previews_own_exif_orientation(monkeypatch: pytest.MonkeyPatch) -> None:
    # Orientation 6 rotates the JPEG to portrait; the raw's flip must not turn it again.
    fake = _FakeRaw(_Thumb("jpeg", _jpeg_bytes((1600, 1000), "red", orientation=6)), flip=6)
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (1000, 1600)


def test_open_raw_accepts_bitmap_previews(monkeypatch: pytest.MonkeyPatch) -> None:
    pixels = np.zeros((1000, 1600, 3), dtype=np.uint8)
    pixels[..., 1] = 255
    fake = _FakeRaw(_Thumb("bitmap", pixels), flip=0)
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (1600, 1000)
    assert picture.getpixel((0, 0)) == (0, 255, 0)


def test_open_raw_develops_when_there_is_no_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    developed = np.full((500, 800, 3), 200, dtype=np.uint8)
    fake = _FakeRaw(_NoThumbnail(), flip=6, develop=lambda: developed)
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (800, 500)
    assert fake.postprocess_calls == [{"use_camera_wb": True, "half_size": True}]


def test_open_raw_develops_when_the_preview_is_too_small(monkeypatch: pytest.MonkeyPatch) -> None:
    developed = np.full((500, 800, 3), 200, dtype=np.uint8)
    fake = _FakeRaw(_Thumb("jpeg", _jpeg_bytes((160, 120), "red")), develop=lambda: developed)
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (800, 500)


def test_open_raw_falls_back_to_a_small_preview_when_development_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeRaw(_Thumb("jpeg", _jpeg_bytes((160, 120), "red")))
    _install_fake_rawpy(monkeypatch, fake)

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.size == (160, 120)
    assert len(fake.postprocess_calls) == 1


def test_open_raw_raises_when_nothing_can_be_rendered(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeRaw(_UnsupportedThumbnail())
    _install_fake_rawpy(monkeypatch, fake)

    with pytest.raises(RuntimeError, match="cannot develop"):
        raw_module.open_raw("/photos/a.arw", 1024)


def test_open_raw_converts_grayscale_previews_to_rgb(monkeypatch: pytest.MonkeyPatch) -> None:
    buffer = io.BytesIO()
    Image.new("L", (1200, 800), color=90).save(buffer, "JPEG")
    _install_fake_rawpy(monkeypatch, _FakeRaw(_Thumb("jpeg", buffer.getvalue())))

    picture = raw_module.open_raw("/photos/a.arw", 1024)

    assert picture.mode == "RGB"


def test_generate_routes_raw_extensions_through_libraw(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = tmp_path / "DSC00001.ARW"
    src.write_bytes(b"not really a raw file")
    buffer = io.BytesIO()
    Image.new("RGB", (1616, 1080), color="orange").save(buffer, "JPEG")
    _install_fake_rawpy(monkeypatch, _FakeRaw(_Thumb("jpeg", buffer.getvalue()), flip=0))

    def unexpected_pillow_open(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("Pillow must not open a raw file directly")

    monkeypatch.setattr(thumbs_io, "_open_image", unexpected_pillow_open)
    thumbs_dir = tmp_path / "thumbs"

    results = thumbs_io.generate(str(src), ".arw", "rawsha", src.stat().st_size, str(thumbs_dir), max_bytes=200_000_000)

    assert [(size, w, h) for size, _rel, w, h in results] == [(256, 256, 171), (1024, 1024, 684)]
    for _size, rel, _w, _h in results:
        with Image.open(thumbs_dir / rel) as written:
            assert written.format == "WEBP"


def test_generate_reports_a_raw_that_libraw_cannot_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = tmp_path / "broken.arw"
    src.write_bytes(b"garbage")
    fake = types.ModuleType("rawpy")

    def imread(_path: str) -> object:
        raise OSError("LibRaw: unsupported file format")

    fake.imread = imread  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "rawpy", fake)
    errors: list[str] = []

    results = thumbs_io.generate(
        str(src), ".arw", "brokensha", src.stat().st_size, str(tmp_path / "thumbs"), max_bytes=200_000_000,
        on_error=errors.append,
    )

    assert results == []
    assert errors and "unsupported file format" in errors[0]
