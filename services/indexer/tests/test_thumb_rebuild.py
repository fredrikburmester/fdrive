"""Tests for thumb_rebuild.py.

`ThumbnailRebuildJob` bookkeeping is pure enough to test directly with no
fixtures. `rebuild_thumbnails`, `count_candidates`, and `start_rebuild` are I/O:
they run against a real Postgres (via conftest's testcontainers fixture) and a
`tmp_path` root with a real small PNG and PDF, mirroring test_indexer.py's
pattern.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from fdrive_indexer import db, thumb_rebuild
from fdrive_indexer.config import Config
from fdrive_indexer.features import FeatureConfiguration, FeatureValues
from fdrive_indexer.indexer import RootContext


class _StubExtractor:
    """Thumbnail rebuild never touches text extraction, so a minimal stand-in is
    enough; it is only here because RootContext requires an extractor."""

    def extract(self, abs_path: str, rel_path: str, ext: str, size: int) -> tuple[str | None, str]:
        return None, "none"


class _SyncThread:
    """Runs `target` synchronously on `.start()` so background-job tests do not
    need to poll or sleep."""

    def __init__(self, target: object, daemon: bool = True, name: str | None = None) -> None:
        self._target = target

    def start(self) -> None:
        self._target()  # type: ignore[operator]


def _make_config(monkeypatch: pytest.MonkeyPatch, database_url: str, thumbs_dir: str) -> Config:
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("INDEX_ROOTS", "sftpgo=/unused")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    monkeypatch.setenv("THUMBS_DIR", thumbs_dir)
    return Config()


def _make_context(cfg: Config, root: str, abs_path: str) -> RootContext:
    conn = db.connect(cfg.database_url)
    root_id = db.upsert_root(conn, root)
    settings = cfg.default_settings()
    ctx = RootContext(
        name=root,
        root_id=root_id,
        abs_path=abs_path,
        cfg=cfg,
        settings=settings,
        extractor=_StubExtractor(),  # type: ignore[arg-type]
        features=FeatureConfiguration(0, FeatureValues(True, True, True, True, True, True)),
    )
    ctx.local.conn = conn
    return ctx


def _write_png(path: Path) -> None:
    from PIL import Image

    Image.new("RGB", (400, 200), color="red").save(path)


def _write_pdf(path: Path) -> None:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=400, height=800)
    page.insert_text((72, 72), "hello")
    doc.save(str(path))
    doc.close()


def _upsert_media_file(ctx: RootContext, rel_path: str, ext: str, abs_path: Path, sha256: str) -> int:
    st = abs_path.stat()
    return db.upsert_file(ctx.conn(), ctx.root_id, rel_path, abs_path.name, ext, st.st_size, st.st_mtime_ns, sha256, None)


# -- ThumbnailRebuildJob (pure bookkeeping, no fixtures) -----------------------------------


def test_job_initial_snapshot() -> None:
    job = thumb_rebuild.ThumbnailRebuildJob()
    assert job.snapshot() == {
        "running": False,
        "processed": 0,
        "total": 0,
        "started_at": None,
        "finished_at": None,
        "errors": 0,
    }


def test_job_try_start_blocks_while_running() -> None:
    job = thumb_rebuild.ThumbnailRebuildJob()
    assert job.try_start(3) is True
    assert job.try_start(5) is False
    snap = job.snapshot()
    assert snap["running"] is True
    assert snap["total"] == 3
    assert snap["started_at"] is not None


def test_job_advance_and_finish_track_errors() -> None:
    job = thumb_rebuild.ThumbnailRebuildJob()
    job.try_start(2)
    job.advance(True)
    job.advance(False)
    job.finish()
    snap = job.snapshot()
    assert snap["processed"] == 2
    assert snap["errors"] == 1
    assert snap["running"] is False
    assert snap["finished_at"] is not None


def test_job_can_be_started_again_after_finish() -> None:
    job = thumb_rebuild.ThumbnailRebuildJob()
    job.try_start(1)
    job.advance(True)
    job.finish()
    assert job.try_start(4) is True
    assert job.snapshot()["total"] == 4
    assert job.snapshot()["processed"] == 0


# -- rebuild_thumbnails (I/O: real Postgres + tmp root) ------------------------------------


def test_rebuild_thumbnails_writes_missing_sizes(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    _upsert_media_file(ctx, "a.png", ".png", png, "sha-a")

    processed = thumb_rebuild.rebuild_thumbnails(ctx)
    assert processed == 1
    assert db.thumbnails_count(ctx.conn()) == 2


def test_rebuild_thumbnails_pdf_first_page(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    pdf = tmp_path / "doc.pdf"
    _write_pdf(pdf)
    _upsert_media_file(ctx, "doc.pdf", ".pdf", pdf, "sha-pdf")

    processed = thumb_rebuild.rebuild_thumbnails(ctx)
    assert processed == 1
    assert db.thumbnails_count(ctx.conn()) == 2


def test_rebuild_thumbnails_skips_non_media_and_leaves_text_status(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    txt = tmp_path / "notes.txt"
    txt.write_text("hello")
    file_id = _upsert_media_file(ctx, "notes.txt", ".txt", txt, "sha-t")
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)

    processed = thumb_rebuild.rebuild_thumbnails(ctx)
    assert processed == 0
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["notes.txt"][2] == "indexed"
    assert db.thumbnails_count(ctx.conn()) == 0


def test_rebuild_thumbnails_scoped_to_path(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    (tmp_path / "keep").mkdir()
    (tmp_path / "skip").mkdir()
    keep_png = tmp_path / "keep" / "a.png"
    skip_png = tmp_path / "skip" / "b.png"
    _write_png(keep_png)
    _write_png(skip_png)
    _upsert_media_file(ctx, "keep/a.png", ".png", keep_png, "sha-keep")
    _upsert_media_file(ctx, "skip/b.png", ".png", skip_png, "sha-skip")

    processed = thumb_rebuild.rebuild_thumbnails(ctx, path="keep")
    assert processed == 1
    assert db.thumbnails_count(ctx.conn()) == 2


def test_rebuild_thumbnails_force_regenerates_existing(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    pdf = tmp_path / "doc.pdf"
    _write_pdf(pdf)
    _upsert_media_file(ctx, "doc.pdf", ".pdf", pdf, "sha-pdf")

    thumb_rebuild.rebuild_thumbnails(ctx)
    assert db.thumbnails_count(ctx.conn()) == 2

    processed = thumb_rebuild.rebuild_thumbnails(ctx, force=True)
    assert processed == 1
    assert db.thumbnails_count(ctx.conn()) == 2


def test_rebuild_thumbnails_reports_progress_via_callback(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    _upsert_media_file(ctx, "a.png", ".png", png, "sha-a")

    calls: list[bool] = []
    thumb_rebuild.rebuild_thumbnails(ctx, on_file=calls.append)
    assert calls == [True]


def test_rebuild_stops_admitting_files_when_thumbnails_are_disabled(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    for name, sha in (("a.png", "sha-a"), ("b.png", "sha-b")):
        path = tmp_path / name
        _write_png(path)
        _upsert_media_file(ctx, name, ".png", path, sha)
    generated: list[str] = []

    def stop_after_first(*_args: object, **_kwargs: object) -> list[object]:
        generated.append("one")
        ctx.set_features(FeatureConfiguration(2, FeatureValues(False, True, False, False, False, False)))
        return []

    monkeypatch.setattr(thumb_rebuild, "generate_thumbnails", stop_after_first)
    assert thumb_rebuild.rebuild_thumbnails(ctx) == 1
    assert generated == ["one"]


def test_rebuild_thumbnails_db_failure_reports_via_callback(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    _upsert_media_file(ctx, "a.png", ".png", png, "sha-a")

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("db exploded")

    monkeypatch.setattr(thumb_rebuild.db, "upsert_thumbnail", boom)
    calls: list[bool] = []
    processed = thumb_rebuild.rebuild_thumbnails(ctx, on_file=calls.append)
    assert processed == 1
    assert calls == [False]


def test_rebuild_thumbnails_no_candidates_returns_zero(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    assert thumb_rebuild.rebuild_thumbnails(ctx) == 0


# -- count_candidates and start_rebuild (I/O + background thread) --------------------------


def test_count_candidates_sums_across_contexts(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    ctx_a = _make_context(cfg, "root-a", str(tmp_path / "a"))
    ctx_b = _make_context(cfg, "root-b", str(tmp_path / "b"))
    png_a = tmp_path / "a" / "1.png"
    png_b = tmp_path / "b" / "2.png"
    _write_png(png_a)
    _write_png(png_b)
    _upsert_media_file(ctx_a, "1.png", ".png", png_a, "sha-1")
    _upsert_media_file(ctx_b, "2.png", ".png", png_b, "sha-2")

    assert thumb_rebuild.count_candidates([ctx_a, ctx_b], None) == 2


def test_start_rebuild_runs_and_updates_job(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(thumb_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    _upsert_media_file(ctx, "a.png", ".png", png, "sha-a")

    job = thumb_rebuild.ThumbnailRebuildJob()
    total = thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert total == 1
    snap = job.snapshot()
    assert snap["running"] is False
    assert snap["processed"] == 1
    assert snap["total"] == 1
    assert snap["errors"] == 0
    assert snap["started_at"] is not None
    assert snap["finished_at"] is not None
    assert db.thumbnails_count(ctx.conn()) == 2


def test_start_rebuild_returns_none_when_already_running(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    job = thumb_rebuild.ThumbnailRebuildJob()
    assert job.try_start(5) is True
    result = thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert result is None


def test_start_rebuild_job_crash_still_releases_job(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(thumb_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(*args: object, **kwargs: object) -> int:
        raise RuntimeError("boom")

    monkeypatch.setattr(thumb_rebuild, "rebuild_thumbnails", boom)
    job = thumb_rebuild.ThumbnailRebuildJob()
    total = thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert total == 0
    snap = job.snapshot()
    assert snap["running"] is False
    assert snap["finished_at"] is not None


def test_start_rebuild_thread_uses_own_connection(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Not synchronous this time: exercises the real `threading.Thread` path, so
    the background thread must open its own connection via `ctx.conn()`."""
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    _upsert_media_file(ctx, "a.png", ".png", png, "sha-a")

    job = thumb_rebuild.ThumbnailRebuildJob()
    total = thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert total == 1

    done = threading.Event()

    def wait_done() -> None:
        while job.snapshot()["running"]:
            threading.Event().wait(0.02)
        done.set()

    waiter = threading.Thread(target=wait_done)
    waiter.start()
    waiter.join(timeout=10)
    assert done.is_set()
    assert job.snapshot()["processed"] == 1
