"""inotify watcher tests. Linux only: the module calls `ctypes.CDLL("libc.so.6")` at
import time, so both the import and every test here are skipped elsewhere. Run these
for real with `scripts/test-in-docker.sh` on a non-Linux development machine.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="inotify is Linux-only")


def _wait_until(predicate: object, timeout: float = 5.0, interval: float = 0.05) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(interval)
    return predicate()  # type: ignore[operator]


class Recorder:
    def __init__(self) -> None:
        self.indexed: list[tuple[str, str]] = []
        self.deleted: list[tuple[str, bool]] = []
        self.renamed: list[tuple[str, str, bool]] = []
        self.logs: list[str] = []

    def log(self, msg: str) -> None:
        self.logs.append(msg)

    def index_file(self, abs_path: str, rel_path: str, st: os.stat_result) -> str:
        self.indexed.append((abs_path, rel_path))
        return "indexed"

    def mark_deleted(self, rel_path: str, is_dir: bool) -> int:
        self.deleted.append((rel_path, is_dir))
        return 1

    def rename(self, old_rel: str, new_rel: str, is_dir: bool) -> int:
        self.renamed.append((old_rel, new_rel, is_dir))
        return 1


@pytest.fixture
def watcher_module() -> object:
    from fdrive_indexer import watcher as watcher_mod

    return watcher_mod


def test_watcher_detects_new_file(tmp_path: Path, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)
    w.start()
    (tmp_path / "a.txt").write_text("hello")
    assert _wait_until(lambda: len(rec.indexed) == 1, timeout=5)
    assert rec.indexed[0][1] == "a.txt"


def test_watcher_detects_delete(tmp_path: Path, watcher_module: object) -> None:
    p = tmp_path / "a.txt"
    p.write_text("hello")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)
    w.start()
    assert _wait_until(lambda: w.dirs >= 1)
    p.unlink()
    assert _wait_until(lambda: len(rec.deleted) == 1, timeout=5)
    assert rec.deleted[0] == ("a.txt", False)


def test_watcher_detects_rename(tmp_path: Path, watcher_module: object) -> None:
    p = tmp_path / "old.txt"
    p.write_text("hello")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)
    w.start()
    assert _wait_until(lambda: w.dirs >= 1)
    p.rename(tmp_path / "new.txt")
    assert _wait_until(lambda: len(rec.renamed) == 1, timeout=5)
    assert rec.renamed[0] == ("old.txt", "new.txt", False)


def test_watcher_detects_new_directory_and_its_files(tmp_path: Path, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)
    w.start()
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "inner.txt").write_text("hi")
    assert _wait_until(lambda: any(rel == "sub/inner.txt" for _abs, rel in rec.indexed), timeout=5)


def test_watcher_renames_directory_and_rekeys_watches(tmp_path: Path, watcher_module: object) -> None:
    src = tmp_path / "srcdir"
    src.mkdir()
    (src / "a.txt").write_text("hi")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)
    w.start()
    assert _wait_until(lambda: w.dirs >= 2)
    src.rename(tmp_path / "dstdir")
    assert _wait_until(lambda: len(rec.renamed) == 1, timeout=5)
    assert rec.renamed[0] == ("srcdir", "dstdir", True)


def test_watcher_ignores_skip_dirs_and_junk_names(tmp_path: Path, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(
        str(tmp_path),
        rec.log,
        rec.index_file,
        rec.mark_deleted,
        rec.rename,
        debounce=0.2,
        skip_dirs=frozenset({"node_modules"}),
        skip_names=frozenset({".DS_Store"}),
    )
    w.start()
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.txt").write_text("x")
    (tmp_path / ".DS_Store").write_text("junk")
    (tmp_path / "real.txt").write_text("real")
    assert _wait_until(lambda: len(rec.indexed) == 1, timeout=5)
    assert rec.indexed[0][1] == "real.txt"


def test_watcher_add_watch_nonexistent_path_returns_false(tmp_path: Path, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename)
    assert w._add_watch(str(tmp_path / "does-not-exist")) is False


def test_watcher_init_raises_when_inotify_init_fails(monkeypatch: pytest.MonkeyPatch, watcher_module: object) -> None:
    monkeypatch.setattr(watcher_module._libc, "inotify_init1", lambda flags: -1)
    with pytest.raises(OSError):
        watcher_module.Watcher(".", lambda m: None, lambda *a: "indexed", lambda *a: 0, lambda *a: 0)


def test_watcher_reader_recovers_from_read_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.2)

    calls = {"n": 0}
    real_read = os.read

    def flaky_read(fd: int, n: int) -> bytes:
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("boom")
        return real_read(fd, n)

    monkeypatch.setattr(watcher_module.os, "read", flaky_read)
    monkeypatch.setattr(watcher_module.time, "sleep", lambda s: None)
    w.start()
    (tmp_path / "a.txt").write_text("hi")
    assert _wait_until(lambda: len(rec.indexed) == 1, timeout=5)


def test_watcher_move_from_without_move_to_is_treated_as_delete(tmp_path: Path, watcher_module: object) -> None:
    p = tmp_path / "a.txt"
    p.write_text("hi")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.1)
    w.start()
    assert _wait_until(lambda: w.dirs >= 1)
    outside = tmp_path.parent / f"moved-out-{os.getpid()}.txt"
    try:
        p.rename(outside)
        assert _wait_until(lambda: len(rec.deleted) == 1, timeout=5)
    finally:
        if outside.exists():
            outside.unlink()


def test_watcher_move_to_from_outside_is_treated_as_new(tmp_path: Path, watcher_module: object) -> None:
    outside_dir = tmp_path.parent / f"outside-{os.getpid()}"
    outside_dir.mkdir(exist_ok=True)
    src = outside_dir / "a.txt"
    src.write_text("hi")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.1)
    w.start()
    try:
        src.rename(tmp_path / "a.txt")
        assert _wait_until(lambda: len(rec.indexed) == 1, timeout=5)
    finally:
        if outside_dir.exists():
            import shutil

            shutil.rmtree(outside_dir, ignore_errors=True)


def test_watcher_overflow_triggers_wake_and_rebuild(watcher_module: object, tmp_path: Path) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.1)
    w.add_tree(str(tmp_path))
    w._on_event(0, watcher_module.IN_Q_OVERFLOW, 0, "")
    assert w.wake.is_set()
    assert w._rebuild is True


def test_watcher_ignored_event_drops_watch(watcher_module: object, tmp_path: Path) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.1)
    w.add_tree(str(tmp_path))
    wd = next(iter(w._wd_path))
    w._on_event(wd, watcher_module.IN_IGNORED, 0, "")
    assert wd not in w._wd_path


def test_flush_handles_rename_failure(watcher_module: object, tmp_path: Path) -> None:
    def rename_boom(old: str, new: str, is_dir: bool) -> int:
        raise RuntimeError("db down")

    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rename_boom, debounce=0.0)
    from concurrent.futures import ThreadPoolExecutor

    w._renames.append(("old.txt", "new.txt", False, 0.0))
    with ThreadPoolExecutor(max_workers=1) as pool:
        w._flush(pool)
    assert any("rename" in line and "failed" in line for line in rec.logs)


def test_flush_handles_delete_failure(watcher_module: object, tmp_path: Path) -> None:
    def mark_deleted_boom(rel: str, is_dir: bool) -> int:
        raise RuntimeError("db down")

    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, mark_deleted_boom, rec.rename, debounce=0.0)
    from concurrent.futures import ThreadPoolExecutor

    w._pending["missing.txt"] = ("deleted", False, 0.0)
    with ThreadPoolExecutor(max_workers=1) as pool:
        w._flush(pool)
    assert any("delete" in line and "failed" in line for line in rec.logs)


def test_flush_handles_stat_error(watcher_module: object, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "a.txt"
    p.write_text("hi")
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.0)

    def flaky_lstat(path: str) -> os.stat_result:
        raise PermissionError("nope")

    monkeypatch.setattr(watcher_module.os, "lstat", flaky_lstat)
    from concurrent.futures import ThreadPoolExecutor

    w._pending["a.txt"] = ("changed", False, 0.0)
    with ThreadPoolExecutor(max_workers=1) as pool:
        w._flush(pool)
    assert any("stat" in line for line in rec.logs)


def test_index_handles_missing_file(watcher_module: object, tmp_path: Path) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename)
    assert w._index(str(tmp_path / "missing.txt")) == "deleted"


def test_index_skips_non_regular_files(watcher_module: object, tmp_path: Path) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename)
    fifo_path = tmp_path / "fifo"
    os.mkfifo(fifo_path)
    assert w._index(str(fifo_path)) == "skipped"


def test_dispatcher_thread_runs_flush_periodically(tmp_path: Path, watcher_module: object) -> None:
    rec = Recorder()
    w = watcher_module.Watcher(str(tmp_path), rec.log, rec.index_file, rec.mark_deleted, rec.rename, debounce=0.1)
    w.start()
    (tmp_path / "a.txt").write_text("hi")
    assert _wait_until(lambda: len(rec.indexed) == 1, timeout=5)
