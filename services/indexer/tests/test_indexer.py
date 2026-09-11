"""I/O tests for indexer.py: real filesystem tree (tmp_path) + real Postgres
(via conftest's testcontainers fixture). Extraction, embedding and thumbnailing are
stubbed via a fake `Extractor`-shaped object and a monkeypatched thumbnail generator
so these tests exercise the orchestration, not TEI/Tika/tesseract themselves.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from fdrive_indexer import db, indexer
from fdrive_indexer.config import Config
from fdrive_indexer.features import FeatureConfiguration, FeatureValues
from fdrive_indexer.image_embed import ImageEmbedHealth
from fdrive_indexer.settings import Settings
from fdrive_indexer.thumbs import storage_path as thumb_storage_path


class _StubExtractor:
    """Deterministic stand-in for Extractor: returns fixed text for `.txt`, nothing
    for anything else, so tests do not depend on TEI/Tika/tesseract being up."""

    def __init__(self, root: str) -> None:
        self.root = root

    def extract(self, abs_path: str, rel_path: str, ext: str, size: int, *, search_ocr: bool = False) -> tuple[str | None, str]:
        if ext == ".txt":
            return "hello world " * 5, "indexed"
        if ext == ".pdf":
            return None, "error:BadFile"
        return None, "none"


def _make_config(
    monkeypatch: pytest.MonkeyPatch,
    database_url: str,
    embed_url: str = "http://embed.invalid",
    image_embed_url: str = "",
) -> Config:
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("INDEX_ROOTS", "sftpgo=/unused")
    monkeypatch.setenv("EMBED_URL", embed_url)
    monkeypatch.setenv("INDEX_WORKERS", "2")
    if image_embed_url:
        monkeypatch.setenv("IMAGE_EMBED_URL", image_embed_url)
    else:
        monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)
    return Config()


def _make_context(cfg: Config, root: str, abs_path: str) -> indexer.RootContext:
    conn = db.connect(cfg.database_url)
    root_id = db.upsert_root(conn, root)
    settings = cfg.default_settings()
    ctx = indexer.RootContext(
        name=root,
        root_id=root_id,
        abs_path=abs_path,
        cfg=cfg,
        settings=settings,
        extractor=_StubExtractor(root),  # type: ignore[arg-type]
        features=FeatureConfiguration(0, FeatureValues(True, True, True, True, True, True)),
    )
    ctx.local.conn = conn
    return ctx


def test_sha256_of(tmp_path: Path) -> None:
    p = tmp_path / "a.bin"
    p.write_bytes(b"hello world")
    import hashlib

    assert indexer.sha256_of(str(p)) == hashlib.sha256(b"hello world").hexdigest()


def test_sha256_of_rejects_file_replaced_by_fifo_without_blocking(tmp_path: Path) -> None:
    path = tmp_path / "replaced.txt"
    path.write_text("regular when scanned")
    path.unlink()
    os.mkfifo(path)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from fdrive_indexer.indexer import sha256_of; sha256_of(sys.argv[1])",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )

    assert result.returncode != 0
    assert "not a regular file" in result.stderr
    with pytest.raises(OSError, match="not a regular file"):
        indexer.sha256_of(str(path))


def test_walk_skips_junk_and_sorts(tmp_path: Path) -> None:
    (tmp_path / "b.txt").write_text("b")
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / ".DS_Store").write_text("junk")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.txt").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "c.txt").write_text("c")

    results = list(indexer.walk(str(tmp_path), frozenset({".DS_Store"}), frozenset({"node_modules"})))
    rels = sorted(r[1] for r in results)
    assert rels == ["a.txt", "b.txt", "sub/c.txt"]


def test_walk_skips_fifo(tmp_path: Path) -> None:
    os.mkfifo(tmp_path / "pipe")

    assert list(indexer.walk(str(tmp_path), frozenset(), frozenset())) == []


class _FakeEntry:
    def __init__(self, name: str, path: str, is_dir_: bool, is_file_: bool, stat_error: Exception | None = None) -> None:
        self.name = name
        self.path = path
        self._is_dir = is_dir_
        self._is_file = is_file_
        self._stat_error = stat_error

    def is_dir(self, follow_symlinks: bool = True) -> bool:
        return self._is_dir

    def is_file(self, follow_symlinks: bool = True) -> bool:
        return self._is_file

    def stat(self, follow_symlinks: bool = True) -> os.stat_result:
        if self._stat_error is not None:
            raise self._stat_error
        return _stat_with(1, 1)


def test_walk_skips_neither_file_nor_dir_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_entries = [_FakeEntry("broken-symlink", str(tmp_path / "broken-symlink"), False, False)]
    monkeypatch.setattr(indexer.os, "scandir", lambda d: iter(fake_entries))
    results = list(indexer.walk(str(tmp_path), frozenset(), frozenset()))
    assert results == []


def test_walk_logs_and_skips_entry_whose_stat_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_entries = [
        _FakeEntry("vanished.txt", str(tmp_path / "vanished.txt"), False, True, stat_error=OSError("gone")),
    ]
    monkeypatch.setattr(indexer.os, "scandir", lambda d: iter(fake_entries))
    results = list(indexer.walk(str(tmp_path), frozenset(), frozenset()))
    assert results == []


def test_walk_logs_and_skips_unreadable_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    good = tmp_path / "good.txt"
    good.write_text("x")
    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()

    real_scandir = os.scandir

    def flaky_scandir(path: str) -> object:
        if str(path) == str(bad_dir):
            raise OSError("permission denied")
        return real_scandir(path)

    monkeypatch.setattr(indexer.os, "scandir", flaky_scandir)
    results = list(indexer.walk(str(tmp_path), frozenset(), frozenset()))
    assert [r[1] for r in results] == ["good.txt"]


def _stat_with(size: int, mtime_ns: int) -> os.stat_result:
    base = (0o100644, 1, 1, 1, 0, 0, size, 0, 0, 0)
    return os.stat_result(base, {"st_mtime_ns": mtime_ns})


def test_unchanged_in_db_true_and_false() -> None:
    st = _stat_with(10, 123)
    assert indexer.unchanged_in_db(None, st) is False
    assert indexer.unchanged_in_db((10, 123, "indexed", None), st) is True
    assert indexer.unchanged_in_db((10, 123, "pending", None), st) is False
    assert indexer.unchanged_in_db((10, 123, "indexed", "deleted"), st) is False
    assert indexer.unchanged_in_db((9, 123, "indexed", None), st) is False


def test_path_locks_reclaims_unique_paths() -> None:
    locks = indexer.PathLocks()
    for key in map(str, range(1_000)):
        with locks.get(key):
            pass

    assert locks._locks == {}


def test_path_locks_keep_waiters_on_same_lock_until_all_finish() -> None:
    locks = indexer.PathLocks()
    holder_entered = threading.Event()
    release_holder = threading.Event()
    waiter_entered = threading.Event()
    release_waiter = threading.Event()
    newcomer_entered = threading.Event()

    def hold_first() -> None:
        with locks.get("same"):
            holder_entered.set()
            assert release_holder.wait(2)

    def wait_second() -> None:
        with locks.get("same"):
            waiter_entered.set()
            assert release_waiter.wait(2)

    def enter_third() -> None:
        with locks.get("same"):
            newcomer_entered.set()

    def wait_for_users(expected: int) -> None:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with locks._lock:
                if locks._locks["same"].users == expected:
                    return
            time.sleep(0.001)
        pytest.fail(f"expected {expected} registered lock users")

    holder = threading.Thread(target=hold_first)
    waiter = threading.Thread(target=wait_second)
    holder.start()
    assert holder_entered.wait(2)
    waiter.start()
    wait_for_users(2)

    release_holder.set()
    assert waiter_entered.wait(2)
    holder.join(2)
    assert not holder.is_alive()
    with locks._lock:
        assert locks._locks["same"].users == 1

    newcomer = threading.Thread(target=enter_third)
    newcomer.start()
    wait_for_users(2)
    assert not newcomer_entered.wait(0.05)
    release_waiter.set()
    waiter.join(2)
    newcomer.join(2)

    assert not waiter.is_alive()
    assert not newcomer.is_alive()
    assert newcomer_entered.is_set()
    assert locks._locks == {}


def test_process_file_indexes_new_text_file(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    changed = indexer.process_file(ctx, str(p), "a.txt", st)
    assert changed is True

    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "indexed"


def test_process_file_unchanged_returns_false(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    assert indexer.process_file(ctx, str(p), "a.txt", st) is True
    assert indexer.process_file(ctx, str(p), "a.txt", st) is False


def test_process_file_embed_failure_marks_partial(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    def boom(pieces: list[str], url: str, batch: int) -> list[list[float]]:
        raise RuntimeError("embed service down")

    monkeypatch.setattr(indexer, "embed_passages", boom)
    p = tmp_path / "a.txt"
    p.write_text("hello")
    indexer.process_file(ctx, str(p), "a.txt", os.stat(p))
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "partial"


def test_process_file_error_status(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    p = tmp_path / "a.pdf"
    p.write_text("hello")
    indexer.process_file(ctx, str(p), "a.pdf", os.stat(p))
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.pdf"][2] == "error"


def test_process_file_excluded_by_glob(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.settings = Settings(
        scan_interval_seconds=900,
        workers=2,
        text_exclude_globs=("sftpgo/a.txt",),
        ocr_image_globs=(),
        tesseract_langs="eng",
    )
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    p = tmp_path / "a.txt"
    p.write_text("hello")
    indexer.process_file(ctx, str(p), "a.txt", os.stat(p))
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "excluded"


def test_process_file_non_textual_extension(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    p = tmp_path / "a.zip"
    p.write_bytes(b"PK")
    indexer.process_file(ctx, str(p), "a.zip", os.stat(p))
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.zip"][2] == "none"


def test_process_file_generates_thumbnails(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [(256, "ab/abc.256.webp", 256, 128)])
    p = tmp_path / "a.zip"
    p.write_bytes(b"PK")
    indexer.process_file(ctx, str(p), "a.zip", os.stat(p))
    assert db.thumbnails_count(ctx.conn()) == 1


def test_semantic_disabled_indexes_text_without_calling_embed(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.features = FeatureConfiguration(3, FeatureValues(False, True, False, False, False, False))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda *_a, **_k: pytest.fail("embed must be disabled"))
    path = tmp_path / "a.txt"
    path.write_text("searchable text")
    assert indexer.process_file(ctx, str(path), "a.txt", os.stat(path)) is True
    assert db.get_manifest(ctx.conn(), ctx.root_id)["a.txt"][2] == "partial"


def test_image_search_generates_internal_thumbnails_when_presentation_is_off(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.features = FeatureConfiguration(3, FeatureValues(False, False, False, False, True, False))
    generated: list[str] = []
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: generated.append("yes") or [])
    path = tmp_path / "a.jpg"
    path.write_bytes(b"not-a-real-image")
    assert indexer.process_file(ctx, str(path), "a.jpg", os.stat(path)) is True
    assert generated == ["yes"]


def test_all_features_disabled_does_not_admit_file_processing(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.features = FeatureConfiguration(3, FeatureValues(False, False, False, False, False, False))
    path = tmp_path / "a.txt"
    path.write_text("untouched")
    assert indexer.process_file(ctx, str(path), "a.txt", os.stat(path)) is False
    assert db.get_manifest(ctx.conn(), ctx.root_id) == {}


def test_cancelled_scan_never_sweeps_unseen_paths(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.features = FeatureConfiguration(3, FeatureValues(False, True, False, False, False, False))
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("first")
    second.write_text("second")
    swept: list[list[str]] = []

    def entries(*_args: object, **_kwargs: object):
        yield str(first), "first.txt", os.stat(first)
        yield str(second), "second.txt", os.stat(second)

    def stop_after_first(*_args: object, **_kwargs: object) -> str:
        ctx.set_features(FeatureConfiguration(4, FeatureValues(False, False, False, False, False, False)))
        return "indexed"

    monkeypatch.setattr(indexer, "walk", entries)
    monkeypatch.setattr(indexer, "safe_process", stop_after_first)
    monkeypatch.setattr(indexer.db, "sweep_vanished", lambda _c, _r, seen, _s: swept.append(seen) or 0)
    indexer.scan_once(ctx)
    assert swept == []


def test_enabling_thumbnails_backfills_unchanged_files_without_reextracting(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.jpg"
    path.write_bytes(b"image")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.jpg", "a.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    ctx.features = FeatureConfiguration(2, FeatureValues(False, False, False, False, False, False))
    ctx.set_features(FeatureConfiguration(3, FeatureValues(True, False, False, False, False, False)))
    generated: list[str] = []
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: generated.append("a") or [])
    monkeypatch.setattr(indexer, "safe_process", lambda *_a, **_k: pytest.fail("text extraction must not run"))
    indexer.scan_once(ctx)
    assert generated == ["a"]


def test_failed_media_backfill_remains_pending_for_unchanged_file(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.jpg"
    path.write_bytes(b"image")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.jpg", "a.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    ctx.features = FeatureConfiguration(2, FeatureValues(False, False, False, False, False, False))
    ctx.set_features(FeatureConfiguration(3, FeatureValues(True, False, False, False, False, False)))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")))
    indexer.scan_once(ctx)
    assert ctx.needs_media_backfill() is True

    generated: list[str] = []
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: generated.append("a") or [])
    indexer.scan_once(ctx)
    assert generated == ["a"]
    assert ctx.needs_media_backfill() is False


def test_enabling_text_reprocesses_unchanged_disabled_row(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.txt"
    path.write_text("same bytes")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "disabled:text", 0, None)
    ctx.features = FeatureConfiguration(2, FeatureValues(False, False, False, False, False, False))
    ctx.set_features(FeatureConfiguration(3, FeatureValues(False, True, False, False, False, False)))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: [])

    indexer.scan_once(ctx)

    assert db.get_manifest(ctx.conn(), ctx.root_id)["a.txt"][2] == "partial"


def test_partial_row_retries_embeddings_without_reextracting(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.txt"
    path.write_text("already indexed")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha", None)
    db.insert_chunks(ctx.conn(), file_id, ["saved text"], [None])
    db.update_file_status(ctx.conn(), file_id, "partial", 10, None)
    ctx.features = FeatureConfiguration(3, FeatureValues(False, True, False, True, False, False))
    embedded: list[str] = []
    monkeypatch.setattr(indexer, "embed_missing", lambda _ctx, rel_path: embedded.append(rel_path))
    monkeypatch.setattr(indexer, "safe_process", lambda *_a: pytest.fail("partial must not re-extract"))

    indexer.scan_once(ctx)

    assert embedded == ["a.txt"]


def test_search_ocr_reprocesses_unchanged_image_dir_exclusion(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.png"
    path.write_bytes(b"image")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "excluded:image_dir", 0, None)
    ctx.features = FeatureConfiguration(3, FeatureValues(False, True, True, False, False, False))
    admitted: list[str] = []
    monkeypatch.setattr(indexer, "safe_process", lambda _ctx, _abs, rel, _st: admitted.append(rel) or "indexed")

    indexer.scan_once(ctx)

    assert admitted == ["a.png"]


def test_media_derivative_backfill_survives_restart_without_transition(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.jpg"
    path.write_bytes(b"image")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.jpg", "a.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    # Direct assignment models a new process that reads an already-enabled
    # persisted feature selection; there was no in-memory transition to flag.
    ctx.features = FeatureConfiguration(7, FeatureValues(True, False, False, False, False, False))
    generated: list[str] = []
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: generated.append("a") or [])

    indexer.scan_once(ctx)

    assert generated == ["a"]


def test_process_file_thumbnail_failure_does_not_break_indexing(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(*a: object, **k: object) -> list[object]:
        raise RuntimeError("thumbnail generator exploded")

    monkeypatch.setattr(indexer, "generate_thumbnails", boom)
    p = tmp_path / "a.txt"
    p.write_text("hello")
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])
    changed = indexer.process_file(ctx, str(p), "a.txt", os.stat(p))
    assert changed is True


# -- embed_thumbnail (the live per-file image-embedding pass) ------------------------------


_HEALTHY = ImageEmbedHealth(status="ok", model="model-a", dim=1024, device="cpu")


def test_embed_thumbnail_noop_when_not_configured(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    assert ctx.cfg.image_embed_url == ""

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not call the sidecar when unconfigured")

    monkeypatch.setattr(indexer, "image_embed_health", boom)
    indexer.embed_thumbnail(ctx, "sha-a")
    assert db.image_embeddings_count(ctx.conn()) == 0


def test_embed_thumbnail_skips_when_dimension_guard_fails(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: None)

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not embed when the sidecar guard fails")

    monkeypatch.setattr(indexer, "embed_images", boom)
    indexer.embed_thumbnail(ctx, "sha-a")
    assert db.image_embeddings_count(ctx.conn()) == 0


def test_embed_thumbnail_missing_file_is_noop(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)
    logged: list[str] = []
    monkeypatch.setattr(indexer, "log", logged.append)
    assert indexer.embed_thumbnail(ctx, "sha-missing-thumb") is False
    assert db.image_embeddings_count(ctx.conn()) == 0
    # Thumbnailing already reported the failure; a missing thumb is not a second error.
    assert logged == []


def _write_thumbnail(cfg: Config, sha256: str) -> None:
    rel = thumb_storage_path(sha256, 256)
    dest = Path(cfg.thumbs_dir) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"fake webp bytes")


def test_embed_thumbnail_embeds_and_upserts(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _write_thumbnail(cfg, "sha-a")
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)

    calls: list[list[bytes]] = []

    def fake_embed_images(images: list[bytes], url: str, batch: int) -> tuple[list[list[float]], str]:
        calls.append(images)
        return [[0.1] * 1024], "model-a"

    monkeypatch.setattr(indexer, "embed_images", fake_embed_images)
    indexer.embed_thumbnail(ctx, "sha-a")
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-a"
    assert len(calls) == 1
    assert calls[0] == [b"fake webp bytes"]


def test_embed_thumbnail_no_embeddings_returned_is_noop(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _write_thumbnail(cfg, "sha-a")
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(indexer, "embed_images", lambda images, url, batch: ([], "model-a"))
    indexer.embed_thumbnail(ctx, "sha-a")
    assert db.image_embedding_model(ctx.conn(), "sha-a") is None


def test_embed_thumbnail_skips_when_current_model_already_present(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _write_thumbnail(cfg, "sha-a")
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-a", [0.5] * 1024)
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not re-embed a file already on the configured model")

    monkeypatch.setattr(indexer, "embed_images", boom)
    indexer.embed_thumbnail(ctx, "sha-a")


def test_embed_thumbnail_reembeds_stale_model(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _write_thumbnail(cfg, "sha-a")
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-old", [0.5] * 1024)
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(indexer, "embed_images", lambda images, url, batch: ([[0.1] * 1024], "model-a"))
    indexer.embed_thumbnail(ctx, "sha-a")
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-a"


def test_process_file_embeds_image_thumbnail(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(indexer, "embed_images", lambda images, url, batch: ([[0.1] * 1024], "model-a"))

    p = tmp_path / "a.png"
    p.write_bytes(b"not-a-real-png")
    sha = indexer.sha256_of(str(p))
    _write_thumbnail(cfg, sha)

    indexer.process_file(ctx, str(p), "a.png", os.stat(p))
    assert db.image_embedding_model(ctx.conn(), sha) == "model-a"


def test_process_file_non_image_never_calls_image_embed_health(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not check image-embed health for a non-image file")

    monkeypatch.setattr(indexer, "image_embed_health", boom)
    p = tmp_path / "a.txt"
    p.write_text("hello")
    indexer.process_file(ctx, str(p), "a.txt", os.stat(p))


def test_process_file_image_embed_failure_does_not_break_indexing(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    def boom(ctx: indexer.RootContext, sha256: str) -> None:
        raise RuntimeError("image embed exploded")

    monkeypatch.setattr(indexer, "embed_thumbnail", boom)
    p = tmp_path / "a.png"
    p.write_bytes(b"not-a-real-png")
    changed = indexer.process_file(ctx, str(p), "a.png", os.stat(p))
    assert changed is True


def test_embed_missing_no_missing_chunks_still_marks_indexed(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    called = False

    def should_not_be_called(*a: object, **k: object) -> list[list[float]]:
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(indexer, "embed_passages", should_not_be_called)
    indexer.embed_missing(ctx, "a.txt")
    assert called is False
    assert db.get_manifest(ctx.conn(), ctx.root_id)["a.txt"][2] == "indexed"


def test_watch_index_delegates_to_safe_process(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])
    p = tmp_path / "a.txt"
    p.write_text("hello")
    assert indexer.watch_index(ctx, str(p), "a.txt", os.stat(p)) == "indexed"


def test_safe_process_error_when_mark_file_error_also_fails(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(ctx_: object, abs_path: str, rel_path: str, st: object) -> bool:
        raise RuntimeError("kaboom")

    def boom_mark_error(*a: object, **k: object) -> None:
        raise RuntimeError("db is also down")

    monkeypatch.setattr(indexer, "process_file", boom)
    monkeypatch.setattr(db, "mark_file_error", boom_mark_error)
    p = tmp_path / "a.txt"
    p.write_text("hello")
    result = indexer.safe_process(ctx, str(p), "a.txt", os.stat(p))
    assert result == "error"


def test_start_watcher_success_path(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import sys
    import types

    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    class FakeWatcher:
        def __init__(
            self, root: str, log_fn: object, index_file: object, mark_deleted: object, rename: object, **kw: object
        ) -> None:
            self.root = root
            self.dirs = 3

        def start(self) -> None:
            self.started = True

    fake_module = types.ModuleType("fdrive_indexer.watcher")
    fake_module.Watcher = FakeWatcher  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fdrive_indexer.watcher", fake_module)

    result = indexer.start_watcher(ctx, workers=2, debounce=1.0)
    assert isinstance(result, FakeWatcher)
    assert result.started is True  # type: ignore[attr-defined]


def test_scan_once_detects_race_with_watcher_as_unchanged(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    # already fully indexed in the DB, matching the file on disk exactly
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)

    # force scan_once's snapshot of the manifest to look empty, as if this file
    # were brand new to the scan; process_file's own fresh read then finds it
    # already matches, simulating the watcher having indexed it moments earlier
    monkeypatch.setattr(db, "get_manifest", lambda conn, root_id: {})

    result = indexer.scan_once(ctx)
    assert result["seen"] == 1
    assert result["changed"] == 0
    assert result["errors"] == 0


def test_scan_once_flushes_pending_queue_when_full(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))  # INDEX_WORKERS=2 -> flush threshold is 16
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])
    for i in range(20):
        (tmp_path / f"f{i}.txt").write_text("hello")
    result = indexer.scan_once(ctx)
    assert result["seen"] == 20
    assert result["changed"] == 20


def test_embed_missing_fills_partial_chunks(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [None])
    db.update_file_status(ctx.conn(), file_id, "partial", 5, "embed:RuntimeError")
    monkeypatch.setattr(indexer, "embed_passages", lambda texts, url, batch: [[0.2] * 384 for _ in texts])
    indexer.embed_missing(ctx, "a.txt")
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "indexed"
    assert db.chunks_missing_embeddings(ctx.conn(), ctx.root_id, "a.txt") == []


def test_safe_process_indexed(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])
    p = tmp_path / "a.txt"
    p.write_text("hello")
    assert indexer.safe_process(ctx, str(p), "a.txt", os.stat(p)) == "indexed"
    assert indexer.safe_process(ctx, str(p), "a.txt", os.stat(p)) == "unchanged"


def test_safe_process_catches_exception_and_marks_error(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)

    def boom(ctx_: object, abs_path: str, rel_path: str, st: object) -> bool:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(indexer, "process_file", boom)
    p = tmp_path / "a.txt"
    p.write_text("hello")
    result = indexer.safe_process(ctx, str(p), "a.txt", os.stat(p))
    assert result == "error"
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "error"


def test_emit_event_failure_is_swallowed(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(conn: object, root_id: int, event: object) -> None:
        raise RuntimeError("notify failed")

    monkeypatch.setattr(db, "record_event", boom)
    indexer.emit_event(ctx, "created", "a.txt")  # must not raise


def test_watch_mark_deleted_emits_event_only_when_rows_affected(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    assert indexer.watch_mark_deleted(ctx, "missing.txt", False) == 0
    db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    assert indexer.watch_mark_deleted(ctx, "a.txt", False) == 1


def test_watch_rename_extension_change_marks_deleted(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    moved = indexer.watch_rename(ctx, "a.txt", "a.pdf", False)
    assert moved == 0
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][3] is not None  # soft-deleted


def test_watch_rename_same_extension_moves_row(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    moved = indexer.watch_rename(ctx, "a.txt", "b.txt", False)
    assert moved == 1
    with ctx.conn().cursor() as cur:
        cur.execute('SELECT src, dst, actor FROM "idx"."moves" WHERE root_id = %s', (ctx.root_id,))
        assert cur.fetchall() == [("a.txt", "b.txt", "watcher")]


def test_watch_rename_no_existing_row_returns_zero(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    assert indexer.watch_rename(ctx, "missing.txt", "new.txt", False) == 0


def test_start_watcher_disabled_returns_none(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    cfg.watch = False
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    assert indexer.start_watcher(ctx, workers=1, debounce=0.1) is None


def test_start_watcher_import_failure_returns_none(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import sys
    import types

    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    # On a non-Linux machine, importing the real watcher module raises at import
    # time (no libc.so.6). To make this deterministic on any platform (including
    # the Linux CI runner and the in-Docker test run, where inotify is really
    # available), inject a stand-in module that lacks `Watcher` so the `from
    # .watcher import Watcher` line raises exactly the same way start_watcher must
    # swallow.
    broken_module = types.ModuleType("fdrive_indexer.watcher")
    monkeypatch.setitem(sys.modules, "fdrive_indexer.watcher", broken_module)
    result = indexer.start_watcher(ctx, workers=1, debounce=0.1)
    assert result is None


def test_scan_once_indexes_new_and_sweeps_vanished(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])

    # a stale row for a file that no longer exists on disk
    db.upsert_file(ctx.conn(), ctx.root_id, "gone.txt", "gone.txt", ".txt", 1, 1, "shagone", None)

    (tmp_path / "a.txt").write_text("hello")
    (tmp_path / "b.txt").write_text("hello again")

    result = indexer.scan_once(ctx)
    assert result["seen"] == 2
    assert result["changed"] == 2
    assert result["deleted"] == 1

    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "indexed"
    assert manifest["gone.txt"][3] is not None


def test_scan_once_skips_already_indexed_unchanged_file(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)

    result = indexer.scan_once(ctx)
    assert result["seen"] == 1
    assert result["changed"] == 0
    assert result["errors"] == 0


def test_scan_once_retries_partial_embeddings(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha1", None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [None])
    db.update_file_status(ctx.conn(), file_id, "partial", 5, "embed:RuntimeError")

    monkeypatch.setattr(indexer, "embed_passages", lambda texts, url, batch: [[0.3] * 384 for _ in texts])
    result = indexer.scan_once(ctx)
    assert result["changed"] == 1
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "indexed"


def test_scan_once_counts_errors(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    (tmp_path / "a.pdf").write_text("hello")
    result = indexer.scan_once(ctx)
    assert result["changed"] == 1  # "error" extraction status still counts as a successful re-index
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.pdf"][2] == "error"


def test_scan_once_embed_retry_failure_is_logged(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])

    p = tmp_path / "a.txt"
    p.write_text("hello")
    st = os.stat(p)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha1", None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [None])
    db.update_file_status(ctx.conn(), file_id, "partial", 5, "embed:RuntimeError")

    def boom(texts: list[str], url: str, batch: int) -> list[list[float]]:
        raise RuntimeError("still down")

    monkeypatch.setattr(indexer, "embed_passages", boom)
    result = indexer.scan_once(ctx)
    assert result["errors"] == 1
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["a.txt"][2] == "partial"


def test_wait_for_embed_succeeds_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    import fdrive_indexer.extract as extract_mod

    monkeypatch.setattr(extract_mod, "embed_health", lambda url: True)
    sleeps: list[float] = []
    assert indexer.wait_for_embed("http://embed.invalid", log_fn=lambda _m: None, sleep=sleeps.append) is True
    assert sleeps == []


def test_wait_for_embed_gives_up_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    import fdrive_indexer.extract as extract_mod

    monkeypatch.setattr(extract_mod, "embed_health", lambda url: False)
    logs: list[str] = []
    sleeps: list[float] = []
    result = indexer.wait_for_embed("http://embed.invalid", log_fn=logs.append, sleep=lambda s: sleeps.append(s))
    assert result is False
    assert len(sleeps) == 300
    assert any("still not healthy" in line for line in logs)
