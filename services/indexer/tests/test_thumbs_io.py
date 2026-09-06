from __future__ import annotations

import os
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
    results = thumbs_io.generate(str(src), ".txt", "sha1", src.stat().st_size, str(tmp_path / "thumbs"), max_bytes=1000)
    assert results == []


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
