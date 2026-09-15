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

import httpx
import pytest

from fdrive_indexer import db, indexer
from fdrive_indexer.config import Config
from fdrive_indexer.embed_backoff import EmbedBackoff
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
    import hashlib

    assert db.file_content_key(ctx.conn(), ctx.root_id, "a.txt") == hashlib.sha256(b"hello").hexdigest()


@pytest.mark.parametrize(
    ("status", "metadata_changed"),
    [("indexed", True), ("pending", False)],
)
def test_process_file_rehashes_changed_and_pending_rows(
    postgres_dsn: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    status: str,
    metadata_changed: bool,
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.txt"
    path.write_text("hello")
    st = os.stat(path)
    stored_size = st.st_size - 1 if metadata_changed else st.st_size
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", stored_size, st.st_mtime_ns, "old", None)
    db.update_file_status(ctx.conn(), file_id, status, 0, None)
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: [])
    monkeypatch.setattr(indexer, "embed_passages", lambda pieces, url, batch: [[0.1] * 384 for _ in pieces])
    hashed: list[str] = []
    monkeypatch.setattr(indexer, "sha256_of", lambda abs_path: hashed.append(abs_path) or "fresh")

    assert indexer.process_file(ctx, str(path), "a.txt", st) is True

    assert hashed == [str(path)]
    assert db.file_content_key(ctx.conn(), ctx.root_id, "a.txt") == "fresh"


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


def test_process_file_stops_probing_an_unreachable_embed_backend(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A missing backend is a service condition: the first file reports it, the
    rest keep their FTS chunks without opening another socket."""
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    calls: list[str] = []
    logs: list[str] = []
    monkeypatch.setattr(indexer, "log", logs.append)

    def refused(pieces: list[str], url: str, batch: int) -> list[list[float]]:
        calls.append(url)
        raise httpx.ConnectError("[Errno 111] Connection refused")

    monkeypatch.setattr(indexer, "embed_passages", refused)
    for name in ("a.txt", "b.txt", "c.txt"):
        path = tmp_path / name
        path.write_text("hello")
        indexer.process_file(ctx, str(path), name, os.stat(path))

    assert len(calls) == 1
    assert len([m for m in logs if "embed backend unreachable" in m]) == 1
    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert [manifest[name][2] for name in ("a.txt", "b.txt", "c.txt")] == ["partial", "partial", "partial"]


def test_process_file_resumes_embedding_once_the_pause_expires(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    now = 0.0
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.embed_backoff = EmbedBackoff(pause_seconds=60, clock=lambda: now)
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    logs: list[str] = []
    monkeypatch.setattr(indexer, "log", logs.append)
    healthy = False

    def flaky(pieces: list[str], url: str, batch: int) -> list[list[float]]:
        if not healthy:
            raise httpx.ConnectError("[Errno 111] Connection refused")
        return [[0.1] * 384 for _ in pieces]

    monkeypatch.setattr(indexer, "embed_passages", flaky)
    first = tmp_path / "a.txt"
    first.write_text("hello")
    indexer.process_file(ctx, str(first), "a.txt", os.stat(first))

    now = 60.0
    healthy = True
    second = tmp_path / "b.txt"
    second.write_text("hello")
    indexer.process_file(ctx, str(second), "b.txt", os.stat(second))

    manifest = db.get_manifest(ctx.conn(), ctx.root_id)
    assert manifest["b.txt"][2] == "indexed"
    assert len([m for m in logs if "reachable again" in m]) == 1


def test_process_file_keeps_reporting_per_file_when_the_backend_answers(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A backend that rejects one payload is not an outage; every file is tried."""
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    calls: list[str] = []
    monkeypatch.setattr(indexer, "log", lambda _m: None)

    def rejected(pieces: list[str], url: str, batch: int) -> list[list[float]]:
        calls.append(url)
        raise httpx.HTTPStatusError(
            "413", request=httpx.Request("POST", "http://embed.invalid/embed"), response=httpx.Response(413)
        )

    monkeypatch.setattr(indexer, "embed_passages", rejected)
    for name in ("a.txt", "b.txt"):
        path = tmp_path / name
        path.write_text("hello")
        indexer.process_file(ctx, str(path), name, os.stat(path))

    assert len(calls) == 2


def test_embed_missing_leaves_the_row_alone_while_the_backend_is_down(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "a.txt"
    path.write_text("hello")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", st.st_size, st.st_mtime_ns, "sha1", None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [None])
    db.update_file_status(ctx.conn(), file_id, "partial", 5, "embed:ConnectError")
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [])
    monkeypatch.setattr(indexer, "log", lambda _m: None)

    def refused(texts: list[str], url: str, batch: int) -> list[list[float]]:
        raise httpx.ConnectError("[Errno -2] Name or service not known")

    monkeypatch.setattr(indexer, "embed_passages", refused)
    assert indexer.embed_missing(ctx, "a.txt") is False
    assert ctx.embed_backoff.paused() is True
    # Neither counted as an error nor marked indexed: the next scan retries it.
    assert indexer.scan_once(ctx)["errors"] == 0
    assert db.get_manifest(ctx.conn(), ctx.root_id)["a.txt"][2] == "partial"


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
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [
        (size, f"ab/abc.{size}.webp", size, size // 2) for size in (256, 1024)
    ])
    p = tmp_path / "a.png"
    p.write_bytes(b"image")
    indexer.process_file(ctx, str(p), "a.png", os.stat(p))
    assert db.thumbnails_count(ctx.conn()) == 2


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
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda _a, _e, sha, *_args, **_kwargs: generated.append(sha) or [])
    monkeypatch.setattr(indexer, "sha256_of", lambda _path: pytest.fail("unchanged backfill must reuse stored sha256"))
    monkeypatch.setattr(indexer, "safe_process", lambda *_a, **_k: pytest.fail("text extraction must not run"))
    indexer.scan_once(ctx)
    assert generated == ["sha"]


def test_enabling_thumbnails_ignores_unchanged_non_media(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "archive.bin"
    path.write_bytes(b"binary")
    st = os.stat(path)
    file_id = db.upsert_file(
        ctx.conn(), ctx.root_id, "archive.bin", "archive.bin", ".bin", st.st_size, st.st_mtime_ns, "sha", None
    )
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    ctx.features = FeatureConfiguration(2, FeatureValues(False, False, False, False, False, False))
    ctx.set_features(FeatureConfiguration(3, FeatureValues(True, False, False, False, False, False)))
    monkeypatch.setattr(indexer, "sha256_of", lambda _path: pytest.fail("non-media backfill must not hash"))
    monkeypatch.setattr(indexer, "backfill_media", lambda *_a, **_k: pytest.fail("non-media backfill must not run"))

    result = indexer.scan_once(ctx)

    assert result["changed"] == 0
    assert ctx.needs_media_backfill() is False


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
    assert ctx.needs_media_backfill() is True
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *a, **k: [
        (size, f"ab/abc.{size}.webp", size, size // 2) for size in (256, 1024)
    ])
    indexer.scan_once(ctx)
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
    monkeypatch.setattr(indexer, "sha256_of", lambda _path: pytest.fail("unchanged feature retry must reuse stored sha256"))

    indexer.scan_once(ctx)

    assert db.get_manifest(ctx.conn(), ctx.root_id)["a.txt"][2] == "partial"
    assert db.file_content_key(ctx.conn(), ctx.root_id, "a.txt") == "sha"


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


def test_over_budget_media_without_thumbnail_is_not_retried(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    cfg.thumb_max_bytes = 1
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = tmp_path / "large.jpg"
    path.write_bytes(b"image")
    st = os.stat(path)
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "large.jpg", "large.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    ctx.features = FeatureConfiguration(7, FeatureValues(True, False, False, False, False, False))
    monkeypatch.setattr(indexer, "sha256_of", lambda _path: pytest.fail("over-budget unchanged media must not hash"))
    monkeypatch.setattr(indexer, "backfill_media", lambda *_a, **_k: pytest.fail("impossible derivative must not retry"))

    result = indexer.scan_once(ctx)

    assert result["changed"] == 0


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
    monkeypatch.setattr(db, "scan_manifest", lambda conn, root_id: {})

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


def test_scan_keeps_other_workers_busy_behind_a_slow_file(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))  # 2 workers, 16 queued jobs
    for i in range(20):
        (tmp_path / f"f{i:02d}.txt").write_text("hello")
    others_done = threading.Event()
    finished: list[str] = []
    lock = threading.Lock()

    def process(_ctx: object, _abs: str, rel: str, _st: object) -> str:
        if rel == "f00.txt":
            # A long video or OCR job: the rest of the tree must not queue up behind it.
            others_done.wait(timeout=5)
        with lock:
            finished.append(rel)
            if len(finished) == 19:
                others_done.set()
        return "indexed"

    monkeypatch.setattr(indexer, "safe_process", process)

    result = indexer.scan_once(ctx)

    assert result["changed"] == 20
    assert finished[-1] == "f00.txt"


def test_scan_reports_its_total_while_every_worker_is_busy(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))  # 2 workers
    for i in range(40):
        (tmp_path / f"f{i:02d}.txt").write_text("hello")

    def text_total() -> object:
        return next(op["total"] for op in ctx.activity.snapshot() if op["features"] == ["textSearch"])

    totals: list[object] = []

    def process(_ctx: object, _abs: str, rel: str, _st: object) -> str:
        deadline = time.monotonic() + 5
        while text_total() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        totals.append(text_total())
        return "indexed"

    monkeypatch.setattr(indexer, "safe_process", process)

    assert indexer.scan_once(ctx)["changed"] == 40
    assert totals[:2] == [40, 40]


def test_scan_waits_for_workers_when_its_backlog_is_full(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))
    monkeypatch.setattr(indexer, "SCAN_BACKLOG_LIMIT", 2)
    for i in range(40):
        (tmp_path / f"f{i:02d}.txt").write_text("hello")
    monkeypatch.setattr(indexer, "safe_process", lambda *_a: time.sleep(0.001) or "indexed")

    assert indexer.scan_once(ctx)["changed"] == 40


@pytest.mark.parametrize("status", ["disabled:search_ocr", "disabled:text"])
def test_rescan_leaves_unchanged_disabled_rows_alone_until_their_feature_is_enabled(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, status: str
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))
    path = tmp_path / "photo.jpg"
    path.write_bytes(b"image")
    st = path.stat()
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "photo.jpg", "photo.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, status, 0, None)
    text_on = status == "disabled:search_ocr"
    ctx.features = FeatureConfiguration(7, FeatureValues(False, text_on, False, False, False, False))
    ctx.set_features(FeatureConfiguration(7, FeatureValues(False, text_on, False, False, False, False)))
    admitted: list[str] = []
    monkeypatch.setattr(indexer, "safe_process", lambda _ctx, _abs, rel, _st: admitted.append(rel) or "unchanged")

    indexer.scan_once(ctx)
    assert admitted == []

    ctx.set_features(FeatureConfiguration(8, FeatureValues(False, True, True, False, False, False)))
    indexer.scan_once(ctx)
    assert admitted == ["photo.jpg"]


def test_scan_classifies_unchanged_media_from_the_manifest(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    root = tmp_path / "root"
    root.mkdir()
    ctx = _make_context(cfg, "sftpgo", str(root))
    for name, sha in (("embedded.jpg", "sha-embedded"), ("pending.jpg", "sha-pending")):
        path = root / name
        path.write_bytes(name.encode())
        st = path.stat()
        file_id = db.upsert_file(ctx.conn(), ctx.root_id, name, name, ".jpg", st.st_size, st.st_mtime_ns, sha, None)
        db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
        for size in (256, 1024):
            thumb = Path(cfg.thumbs_dir) / thumb_storage_path(sha, size)
            thumb.parent.mkdir(parents=True, exist_ok=True)
            thumb.write_bytes(b"webp")
    db.upsert_image_embedding(ctx.conn(), "sha-embedded", "model-a", [0.1] * 1024)
    ctx.features = FeatureConfiguration(7, FeatureValues(True, False, False, False, True, False))
    # A rescan visits every file; per-file lookups would cost a round trip each.
    monkeypatch.setattr(db, "file_content_key", lambda *_a: pytest.fail("classification must use the manifest"))
    monkeypatch.setattr(db, "image_embedding_model", lambda *_a: pytest.fail("classification must use the manifest"))
    admitted: list[str] = []
    monkeypatch.setattr(indexer, "backfill_media", lambda _ctx, _abs, rel, _st: admitted.append(rel) or True)

    indexer.scan_once(ctx)

    assert admitted == ["pending.jpg"]


def _image_scan_context(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, names: tuple[str, ...]
) -> indexer.RootContext:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    root = tmp_path / "root"
    root.mkdir()
    for name in names:
        (root / name).write_bytes(name.encode())
    ctx = _make_context(cfg, "sftpgo", str(root))
    ctx.features = FeatureConfiguration(7, FeatureValues(True, False, False, False, True, False))
    monkeypatch.setattr(indexer, "image_embed_health", lambda _url: _HEALTHY)
    return ctx


def _unresolved_failures(ctx: indexer.RootContext) -> set[tuple[str, str]]:
    rows = ctx.conn().execute("SELECT path, feature FROM idx.processing_failures WHERE resolved_at IS NULL").fetchall()
    return {(row[0], row[1]) for row in rows}


def test_scan_thumbnails_do_not_wait_for_image_embeddings(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    names = ("a.jpg", "b.jpg", "c.jpg")
    ctx = _image_scan_context(postgres_dsn, monkeypatch, tmp_path, names)  # 2 workers
    thumbnailed: list[str] = []
    all_thumbnailed = threading.Event()

    def generate(abs_path: str, _ext: str, sha: str, *_a: object, **_k: object) -> list[tuple[int, str, int, int]]:
        _write_thumbnail(ctx.cfg, sha)
        thumbnailed.append(os.path.basename(abs_path))
        if len(thumbnailed) == len(names):
            all_thumbnailed.set()
        return [(size, thumb_storage_path(sha, size), size, size) for size in (256, 1024)]

    embedded_after_all_thumbnails: list[bool] = []

    def embed(images: list[bytes], _url: str, _batch: int) -> tuple[list[list[float]], str]:
        # A slow model: the third file must still be thumbnailed while this waits.
        embedded_after_all_thumbnails.append(all_thumbnailed.wait(timeout=5))
        return [[0.1] * 1024 for _ in images], "model-a"

    monkeypatch.setattr(indexer, "generate_thumbnails", generate)
    monkeypatch.setattr(indexer, "embed_images", embed)

    result = indexer.scan_once(ctx)

    assert embedded_after_all_thumbnails == [True, True, True]
    assert result["errors"] == 0
    assert db.image_embeddings_count(ctx.conn()) == 3
    image_scan = next(op for op in ctx.activity.snapshot() if op["features"] == ["imageSearch"])
    assert (image_scan["state"], image_scan["processed"], image_scan["total"]) == ("completed", 3, 3)


def test_deferred_image_embedding_failures_count_once_per_file(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _image_scan_context(postgres_dsn, monkeypatch, tmp_path, ("broken.jpg", "rejected.jpg"))

    def generate(abs_path: str, _ext: str, sha: str, *_a: object, on_error: object = None, **_k: object) -> list[object]:
        if abs_path.endswith("broken.jpg"):
            on_error("cannot decode")  # type: ignore[operator]
            return []
        _write_thumbnail(ctx.cfg, sha)
        return [(size, thumb_storage_path(sha, size), size, size) for size in (256, 1024)]

    def reject(*_a: object) -> object:
        raise ValueError("sidecar rejected the image")

    monkeypatch.setattr(indexer, "generate_thumbnails", generate)
    monkeypatch.setattr(indexer, "embed_images", reject)

    result = indexer.scan_once(ctx)

    # broken.jpg fails both stages but is one failed file; rejected.jpg fails only embedding.
    assert result["errors"] == 2
    assert _unresolved_failures(ctx) == {
        ("broken.jpg", "thumbnails"), ("broken.jpg", "imageSearch"), ("rejected.jpg", "imageSearch")
    }
    errors = {op["features"][0]: op["errors"] for op in ctx.activity.snapshot()}
    assert errors == {"thumbnails": 1, "imageSearch": 2}


def test_failed_deferred_image_embedding_keeps_media_backfill_pending(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _image_scan_context(postgres_dsn, monkeypatch, tmp_path, ("a.jpg",))
    st = (Path(ctx.abs_path) / "a.jpg").stat()
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.jpg", "a.jpg", ".jpg", st.st_size, st.st_mtime_ns, "sha", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 0, None)
    ctx.features = FeatureConfiguration(2, FeatureValues(False, False, False, False, False, False))
    ctx.set_features(FeatureConfiguration(3, FeatureValues(True, False, False, False, True, False)))
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda _a, _e, sha, *_r, **_k: _write_thumbnail(ctx.cfg, sha) or [
        (size, thumb_storage_path(sha, size), size, size) for size in (256, 1024)
    ])
    monkeypatch.setattr(indexer, "embed_images", lambda *_a: (_ for _ in ()).throw(ValueError("rejected")))

    indexer.scan_once(ctx)
    assert ctx.needs_media_backfill() is True

    monkeypatch.setattr(indexer, "embed_images", lambda *_a: ([[0.1] * 1024], "model-a"))
    indexer.scan_once(ctx)
    assert ctx.needs_media_backfill() is False


def test_image_embedding_stage_survives_errors_and_drops_queued_work_when_abandoned(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fdrive_indexer.activity import Operation

    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))
    operation = Operation("scan", ["imageSearch"], 1)
    reported: list[tuple[bool, bool]] = []
    release = threading.Event()
    embedded: list[str] = []

    def embed(_ctx: object, rel_path: str, _sha: str) -> bool:
        embedded.append(rel_path)
        if rel_path == "boom.jpg":
            raise RuntimeError("unexpected")
        release.wait(timeout=5)
        return True

    monkeypatch.setattr(indexer, "process_image_embedding", embed)
    stage = indexer.ImageEmbeddingStage(ctx, operation, lambda already, media: reported.append((already, media)))
    for name in ("boom.jpg", "slow.jpg"):
        stage.submit(name, "sha", already_failed=False)
    deadline = time.monotonic() + 5
    while len(embedded) < 2 and time.monotonic() < deadline:
        time.sleep(0.001)
    stage.submit("queued.jpg", "sha", already_failed=False)
    closing = threading.Thread(target=stage.close, kwargs={"abandon": True})
    closing.start()
    while not stage._abandoned and time.monotonic() < deadline:
        time.sleep(0.001)
    release.set()
    closing.join(timeout=5)

    assert embedded == ["boom.jpg", "slow.jpg"]
    assert reported == [(False, False)]
    snapshot = operation.snapshot()
    assert (snapshot["processed"], snapshot["errors"], snapshot["skipped"]) == (3, 1, 2)


def test_image_embed_health_is_reused_across_images_until_it_expires(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    probes: list[str] = []
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: probes.append(url) or _HEALTHY)
    monkeypatch.setattr(indexer, "embed_images", lambda *_a: ([[0.1] * 1024], "model-a"))
    for sha in ("a", "b"):
        _write_thumbnail(cfg, sha)
        assert indexer.embed_thumbnail(ctx, sha) is True
    assert len(probes) == 1

    ctx.image_embed_health_seconds = 0
    _write_thumbnail(cfg, "c")
    assert indexer.embed_thumbnail(ctx, "c") is True
    assert len(probes) == 2


def test_unanswered_health_probe_keeps_a_healthy_answer_but_reported_problems_win(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid"), "sftpgo",
                        str(tmp_path))
    ctx.image_embed_health_seconds = 0
    loading = ImageEmbedHealth(status="loading", model="model-a", dim=None, device="cpu")
    # Not yet known, healthy, busy past the probe timeout, restarted, down.
    answers = iter([None, _HEALTHY, None, loading, None])
    monkeypatch.setattr(indexer, "image_embed_health", lambda _url: next(answers))

    assert [ctx.image_embed_status() for _ in range(5)] == [None, _HEALTHY, _HEALTHY, loading, None]


def test_busy_sidecar_probe_does_not_pause_image_embedding(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.image_embed_health_seconds = 0
    answers = iter([_HEALTHY, None])
    monkeypatch.setattr(indexer, "image_embed_health", lambda _url: next(answers))
    monkeypatch.setattr(indexer, "embed_images", lambda *_a: ([[0.1] * 1024], "model-a"))
    for sha in ("a", "b"):
        _write_thumbnail(cfg, sha)
        assert indexer.embed_thumbnail(ctx, sha) is True
    assert not ctx.image_embed_backoff.waiting()


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


def test_image_backend_outage_is_probed_once_per_backoff_window(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    clock = [0.0]
    ctx.image_embed_backoff = EmbedBackoff(pause_seconds=60, clock=lambda: clock[0])
    calls: list[str] = []
    monkeypatch.setattr(indexer, "image_embed_health", lambda url: calls.append(url))
    for i in range(100):
        assert indexer.embed_thumbnail(ctx, str(i)) is False
    assert len(calls) == 1
    clock[0] = 61
    assert indexer.embed_thumbnail(ctx, "retry") is False
    assert len(calls) == 2


def test_unchanged_exclusion_stays_quiet_and_removed_rule_reindexes(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from dataclasses import replace

    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    ctx.settings = replace(ctx.settings, text_exclude_globs=("sftpgo/*.txt",))
    path = tmp_path / "a.txt"
    path.write_text("excluded")
    monkeypatch.setattr(indexer, "generate_thumbnails", lambda *_a, **_k: [])
    assert indexer.process_file(ctx, str(path), "a.txt", path.stat()) is True
    monkeypatch.setattr(indexer, "safe_process", lambda *_a: pytest.fail("unchanged exclusion must not reindex"))
    monkeypatch.setattr(indexer, "emit_event", lambda *_a: pytest.fail("unchanged exclusion must not emit"))
    indexer.scan_once(ctx)
    assert indexer.process_file(ctx, str(path), "a.txt", path.stat()) is False
    ctx.settings = replace(ctx.settings, text_exclude_globs=())
    admitted: list[str] = []
    monkeypatch.setattr(indexer, "safe_process", lambda _ctx, _abs, rel, _st: admitted.append(rel) or "indexed")
    indexer.scan_once(ctx)
    assert admitted == ["a.txt"]


@pytest.mark.parametrize("rename", [False, True])
def test_watcher_parent_mutation_waits_for_inflight_child(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, rename: bool
) -> None:
    ctx = _make_context(_make_config(monkeypatch, postgres_dsn), "sftpgo", str(tmp_path))
    called = threading.Event()
    monkeypatch.setattr(db, "mark_deleted", lambda *_a: called.set() or [])
    monkeypatch.setattr(db, "rename_paths", lambda *_a: called.set() or 0)
    def operation() -> None:
        if rename:
            indexer.watch_rename(ctx, "docs", "moved", True)
        else:
            indexer.watch_mark_deleted(ctx, "docs", True)

    with ctx.path_locks.get("docs/a.txt"):
        thread = threading.Thread(target=operation)
        thread.start()
        deadline = time.monotonic() + 2
        while "docs" not in ctx.path_locks._locks and time.monotonic() < deadline:
            time.sleep(0.001)
        assert "docs" in ctx.path_locks._locks
        assert not called.is_set()
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert called.is_set()
    assert ctx.path_locks._locks == {}


def test_image_embedding_transport_outage_recovers_after_backoff(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("THUMBS_DIR", str(tmp_path / "thumbs"))
    cfg = _make_config(monkeypatch, postgres_dsn, image_embed_url="http://image-embed.invalid")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    clock = [0.0]
    ctx.image_embed_backoff = EmbedBackoff(pause_seconds=60, clock=lambda: clock[0])
    _write_thumbnail(cfg, "recover")
    monkeypatch.setattr(indexer, "image_embed_health", lambda _url: _HEALTHY)
    logged: list[str] = []
    monkeypatch.setattr(indexer, "log", logged.append)

    def unavailable(*_args: object) -> object:
        raise httpx.ConnectError("backend restarted")

    monkeypatch.setattr(indexer, "embed_images", unavailable)
    assert indexer.embed_thumbnail(ctx, "recover") is False
    assert ctx.image_embed_backoff.paused()
    assert indexer.embed_thumbnail(ctx, "recover") is False
    assert len(logged) == 1
    clock[0] = 61
    monkeypatch.setattr(indexer, "embed_images", lambda *_a: ([[0.1] * 1024], "model-a"))
    assert indexer.embed_thumbnail(ctx, "recover") is True
    assert not ctx.image_embed_backoff.paused()
    assert "resuming image embeddings" in logged[-1]
    assert db.image_embedding_model(ctx.conn(), "recover") == "model-a"


@pytest.mark.parametrize("extension", [".png", ".pdf", ".docx"])
def test_excluded_oversized_inputs_only_retry_after_their_limit_changes(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, extension: str
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn)
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    path = "large" + extension
    assert indexer.exclusion_still_applies(ctx, path, max(cfg.image_max_bytes, cfg.text_max_bytes) + 1)
    assert not indexer.exclusion_still_applies(ctx, path, 1)
