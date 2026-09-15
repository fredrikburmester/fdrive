from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from fdrive_indexer import thumbs_io


def test_generate_image_writes_both_sizes(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "photo.jpg"
    Image.new("RGB", (2000, 1000), color="red").save(src)
    thumbs_dir = tmp_path / "thumbs"
    results = thumbs_io.generate(str(src), ".jpg", "abc123", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    sizes = {r[0] for r in results}
    assert sizes == {256, 1024}
    for size, rel, w, h in results:
        assert (thumbs_dir / rel).exists()
        assert w == size
        assert h == size // 2


def test_generate_heic_image_writes_both_sizes(tmp_path: Path) -> None:
    from PIL import Image

    from fdrive_indexer.heif import register_heif_opener

    register_heif_opener()
    src = tmp_path / "photo.heic"
    img = Image.new("RGB", (1200, 800), color="green")
    img.save(src, format="HEIF")

    thumbs_dir = tmp_path / "thumbs"
    results = thumbs_io.generate(str(src), ".heic", "heicsha123", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    sizes = {r[0] for r in results}
    assert sizes == {256, 1024}
    for size, rel, w, h in results:
        assert (thumbs_dir / rel).exists()
        assert max(w, h) == size


def test_generate_skips_when_thumbnail_already_exists(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "photo.jpg"
    Image.new("RGB", (200, 100), color="blue").save(src)
    thumbs_dir = tmp_path / "thumbs"

    first = thumbs_io.generate(str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    assert len(first) == 2

    # calling again with the same sha256 (same content key) reads the existing
    # files back for their dimensions instead of regenerating them
    second = thumbs_io.generate(str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    assert len(second) == 2
    assert second == first


def test_generate_image_converts_palette_mode(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "palette.png"
    Image.new("P", (300, 150)).save(src)
    thumbs_dir = tmp_path / "thumbs"
    results = thumbs_io.generate(str(src), ".png", "palettesha", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    assert {r[0] for r in results} == {256, 1024}


def test_generate_unknown_extension_returns_empty(tmp_path: Path) -> None:
    src = tmp_path / "notes.txt"
    src.write_text("hello")
    logs: list[str] = []
    results = thumbs_io.generate(
        str(src), ".txt", "sha1", src.stat().st_size, str(tmp_path / "thumbs"), max_bytes=1000, log=logs.append
    )
    assert results == []
    assert logs == []


def test_generate_empty_file_logs_skip_without_decoding(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = tmp_path / "empty.png"
    src.touch()
    logs: list[str] = []

    def unexpected_decode(_path: str) -> object:
        pytest.fail("empty files should not be decoded")

    monkeypatch.setattr(thumbs_io, "_open_image", unexpected_decode)
    assert thumbs_io.generate(str(src), ".png", "empty", 0, str(tmp_path / "thumbs"), 1000, log=logs.append) == []
    assert logs == [f"thumb: skip {src}: empty file"]


def test_generate_over_budget_returns_empty(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "photo.jpg"
    Image.new("RGB", (10, 10)).save(src)
    logs: list[str] = []
    results = thumbs_io.generate(str(src), ".jpg", "sha1", 1_000_000, str(tmp_path / "thumbs"), max_bytes=10, log=logs.append)
    assert results == []
    assert any("over budget" in line for line in logs)


def test_generate_pdf_first_page(tmp_path: Path) -> None:
    import pymupdf

    pdf = tmp_path / "doc.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=800)
    page.insert_text((72, 72), "hello")
    doc.save(str(pdf))
    doc.close()

    results = thumbs_io.generate(str(pdf), ".pdf", "pdfsha", pdf.stat().st_size, str(tmp_path / "thumbs"), max_bytes=10_000_000)
    assert {r[0] for r in results} == {256, 1024}


def test_generate_pdf_corrupt_file_fails_gracefully(tmp_path: Path) -> None:
    pdf = tmp_path / "corrupt.pdf"
    pdf.write_bytes(b"not a real pdf at all")

    logs: list[str] = []
    results = thumbs_io.generate(
        str(pdf), ".pdf", "sha", pdf.stat().st_size, str(tmp_path / "thumbs"), max_bytes=10_000_000, log=logs.append
    )
    assert results == []
    assert any("failed" in line for line in logs)


def test_generate_video_frame(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not a real video, ffmpeg call is mocked")

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        # ffmpeg would write the target path (cmd[-1]); write a real image there instead
        Image.new("RGB", (640, 360), color="green").save(cmd[-1])
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(thumbs_io.subprocess, "run", fake_run)
    results = thumbs_io.generate(
        str(video), ".mp4", "videosha", video.stat().st_size, str(tmp_path / "thumbs"), max_bytes=10_000_000
    )
    assert {r[0] for r in results} == {256, 1024}


def test_generate_force_deletes_and_rewrites_existing(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "photo.jpg"
    Image.new("RGB", (200, 100), color="blue").save(src)
    thumbs_dir = tmp_path / "thumbs"

    first = thumbs_io.generate(str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)
    assert len(first) == 2
    dest_paths = [thumbs_dir / rel for _, rel, _, _ in first]

    removed: list[str] = []

    def tracking_remove(path: str) -> None:
        removed.append(path)
        os.remove(path)

    second = thumbs_io.generate(
        str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000, force=True, remove=tracking_remove
    )
    assert len(removed) == 2
    assert {r[0] for r in second} == {256, 1024}
    assert all(p.exists() for p in dest_paths)


def test_generate_without_force_leaves_existing_untouched(tmp_path: Path) -> None:
    from PIL import Image

    src = tmp_path / "photo.jpg"
    Image.new("RGB", (200, 100), color="blue").save(src)
    thumbs_dir = tmp_path / "thumbs"

    thumbs_io.generate(str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000)

    def failing_remove(path: str) -> None:
        raise AssertionError("remove should not be called without force")

    results = thumbs_io.generate(
        str(src), ".jpg", "sha1", src.stat().st_size, str(thumbs_dir), max_bytes=10_000_000, remove=failing_remove
    )
    assert len(results) == 2


def test_generate_video_frame_failure_is_logged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"broken")

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(thumbs_io.subprocess, "run", fake_run)
    logs: list[str] = []
    results = thumbs_io.generate(
        str(video), ".mp4", "sha", video.stat().st_size, str(tmp_path / "thumbs"), max_bytes=10_000_000, log=logs.append
    )
    assert results == []
    assert any("failed" in line for line in logs)


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, capture_output=True)


requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")


@requires_ffmpeg
def test_generate_video_shorter_than_seek_point_uses_first_frame(tmp_path: Path) -> None:
    video = tmp_path / "short.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=30", str(video))
    errors: list[str] = []
    results = thumbs_io.generate(
        str(video), ".mp4", "shortsha", video.stat().st_size, str(tmp_path / "thumbs"), 10_000_000, on_error=errors.append
    )
    assert errors == []
    assert {r[0] for r in results} == {256, 1024}


@requires_ffmpeg
def test_generate_audio_only_video_is_skipped_not_failed(tmp_path: Path) -> None:
    video = tmp_path / "voice.mp4"
    _ffmpeg("-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac", str(video))
    errors: list[str] = []
    skips: list[str] = []
    logs: list[str] = []
    results = thumbs_io.generate(
        str(video), ".mp4", "voicesha", video.stat().st_size, str(tmp_path / "thumbs"), 10_000_000,
        log=logs.append, on_error=errors.append, on_skip=skips.append,
    )
    assert (results, errors, skips) == ([], [], ["no video stream"])
    assert logs == [f"thumb: skip {video}: no video stream"]


@requires_ffmpeg
def test_generate_truncated_video_is_still_a_failure(tmp_path: Path) -> None:
    video = tmp_path / "truncated.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30", str(video))
    video.write_bytes(video.read_bytes()[:2048])
    errors: list[str] = []
    skips: list[str] = []
    results = thumbs_io.generate(
        str(video), ".mp4", "cutsha", video.stat().st_size, str(tmp_path / "thumbs"), 10_000_000,
        on_error=errors.append, on_skip=skips.append,
    )
    assert (results, skips) == ([], [])
    assert len(errors) == 1 and errors[0].startswith("CalledProcessError")


def test_generate_video_without_any_frame_reports_why(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video = tmp_path / "empty-track.mp4"
    video.write_bytes(b"mocked")
    seeks: list[str] = []

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seeks.append(cmd[cmd.index("-ss") + 1])
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(thumbs_io.subprocess, "run", fake_run)
    errors: list[str] = []
    results = thumbs_io.generate(
        str(video), ".mp4", "sha", video.stat().st_size, str(tmp_path / "thumbs"), 10_000_000, on_error=errors.append
    )
    assert results == []
    assert seeks == ["1.0", "0.0"]
    assert errors == ["ValueError: ffmpeg wrote no video frame"]


def test_generate_video_failure_with_picture_track_is_not_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"mocked")

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, stdout=b"0\n")
        raise subprocess.CalledProcessError(1, cmd, stderr=b"decoder failed")

    monkeypatch.setattr(thumbs_io.subprocess, "run", fake_run)
    errors: list[str] = []
    skips: list[str] = []
    thumbs_io.generate(
        str(video), ".mp4", "sha", video.stat().st_size, str(tmp_path / "thumbs"), 10_000_000,
        on_error=errors.append, on_skip=skips.append,
    )
    assert skips == []
    assert errors == ["CalledProcessError: decoder failed"]


def test_generate_jpeg_over_pillow_pixel_limit_decodes_reduced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    src = tmp_path / "panorama.jpg"
    Image.new("RGB", (4096, 2048), color="orange").save(src)
    # 8.4 MP is over twice this limit; the JPEG drafted to 2048x1024 is not.
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 2_000_000)
    errors: list[str] = []
    results = thumbs_io.generate(
        str(src), ".jpg", "panosha", src.stat().st_size, str(tmp_path / "thumbs"), 10_000_000, on_error=errors.append
    )
    assert errors == []
    assert sorted((size, w, h) for size, _rel, w, h in results) == [(256, 256, 128), (1024, 1024, 512)]


def test_generate_image_still_over_pixel_limit_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    jpeg = tmp_path / "huge.jpg"
    Image.new("RGB", (4096, 2048)).save(jpeg)
    png = tmp_path / "huge.png"
    Image.new("RGB", (4096, 2048)).save(png)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 500_000)
    for src, ext in ((jpeg, ".jpg"), (png, ".png")):
        errors: list[str] = []
        results = thumbs_io.generate(
            str(src), ext, "bigsha", src.stat().st_size, str(tmp_path / "thumbs"), 10_000_000, on_error=errors.append
        )
        assert results == []
        assert len(errors) == 1 and errors[0].startswith("DecompressionBombError"), src


def test_generate_png_with_large_compressed_metadata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image, ImageFile, PngImagePlugin

    monkeypatch.setattr(PngImagePlugin, "MAX_TEXT_CHUNK", ImageFile.SAFEBLOCK)  # Pillow's default
    src = tmp_path / "icon.png"
    info = PngImagePlugin.PngInfo()
    info.add_text("XML:com.adobe.xmp", "x" * (4 * 1024 * 1024), zip=True)
    Image.new("RGB", (64, 64), color="yellow").save(src, pnginfo=info)
    errors: list[str] = []
    results = thumbs_io.generate(
        str(src), ".png", "iconsha", src.stat().st_size, str(tmp_path / "thumbs"), 10_000_000, on_error=errors.append
    )
    assert errors == []
    assert {r[0] for r in results} == {256, 1024}
