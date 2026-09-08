"""Regression coverage for feature-driven watcher and retry lifecycle paths."""

from __future__ import annotations

import errno
import os
import sys
import time
from pathlib import Path

import pytest

from fdrive_indexer.features import FeatureValues
from fdrive_indexer.indexer import should_retry_unchanged

LINUX_ONLY = pytest.mark.skipif(sys.platform != "linux", reason="inotify is Linux-only")


class _Recorder:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, bool]] = []
        self.logs: list[str] = []

    def log(self, message: str) -> None:
        self.logs.append(message)

    def index_file(self, _abs_path: str, _rel_path: str, _st: os.stat_result) -> str:
        return "indexed"

    def mark_deleted(self, rel_path: str, is_dir: bool) -> int:
        self.deleted.append((rel_path, is_dir))
        return 1

    def rename(self, _old_rel: str, _new_rel: str, _is_dir: bool) -> int:
        return 1


@pytest.fixture
def watcher_module() -> object:
    from fdrive_indexer import watcher as watcher_mod

    return watcher_mod


def _watcher(module: object, root: Path, recorder: _Recorder) -> object:
    return module.Watcher(
        str(root),
        recorder.log,
        recorder.index_file,
        recorder.mark_deleted,
        recorder.rename,
        debounce=0.0,
    )


def _wait_until(predicate: object, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(0.02)
    return predicate()  # type: ignore[operator]


@LINUX_ONLY
def test_watcher_stop_is_idempotent_when_descriptor_was_closed(tmp_path: Path, watcher_module: object) -> None:
    """Feature disable must still finish when an earlier failure closed inotify."""
    recorder = _Recorder()
    watcher = _watcher(watcher_module, tmp_path, recorder)
    os.close(watcher.fd)

    watcher.stop()
    watcher.stop()

    assert watcher._stopped.is_set()


@LINUX_ONLY
def test_watcher_reader_retries_nonblocking_empty_queue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, watcher_module: object
) -> None:
    """An idle nonblocking inotify descriptor must not make the reader exit."""
    recorder = _Recorder()
    watcher = _watcher(watcher_module, tmp_path, recorder)
    sleeps: list[float] = []

    def would_block(_fd: int, _size: int) -> bytes:
        raise BlockingIOError(errno.EAGAIN, "queue empty")

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        watcher._stopped.set()

    monkeypatch.setattr(watcher_module.os, "read", would_block)
    monkeypatch.setattr(watcher_module.time, "sleep", sleep)
    try:
        watcher._reader()
    finally:
        os.close(watcher.fd)

    assert sleeps == [0.05]
    assert recorder.logs == []


@LINUX_ONLY
def test_watcher_reader_isolates_one_bad_kernel_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, watcher_module: object
) -> None:
    """A malformed event callback is logged without killing the reader loop."""
    recorder = _Recorder()
    watcher = _watcher(watcher_module, tmp_path, recorder)
    payload = watcher_module._HDR.pack(1, watcher_module.IN_CLOSE_WRITE, 0, 0)

    monkeypatch.setattr(watcher_module.os, "read", lambda _fd, _size: payload)

    def fail_event(*_args: object) -> None:
        watcher._stopped.set()
        raise RuntimeError("bad event")

    monkeypatch.setattr(watcher, "_on_event", fail_event)
    try:
        watcher._reader()
    finally:
        os.close(watcher.fd)

    assert any("event handling failed: RuntimeError: bad event" in message for message in recorder.logs)


@LINUX_ONLY
def test_watcher_removes_descendant_watches_after_directory_delete(tmp_path: Path, watcher_module: object) -> None:
    """Disabling and re-enabling processing cannot retain stale directory watches."""
    removed = tmp_path / "removed"
    removed.mkdir()
    recorder = _Recorder()
    watcher = _watcher(watcher_module, tmp_path, recorder)
    watcher.start()
    try:
        assert _wait_until(lambda: watcher.dirs == 2)
        removed.rmdir()
        assert _wait_until(lambda: ("removed", True) in recorder.deleted)
        assert _wait_until(lambda: watcher.dirs == 1)
    finally:
        watcher.stop()


@LINUX_ONLY
def test_watcher_logs_directory_enumeration_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, watcher_module: object
) -> None:
    """A transient unreadable directory is observable and does not abort the watcher."""
    recorder = _Recorder()
    watcher = _watcher(watcher_module, tmp_path, recorder)
    monkeypatch.setattr(watcher, "_add_watch", lambda _path: True)

    def denied(_path: str) -> object:
        raise PermissionError("denied")

    monkeypatch.setattr(watcher_module.os, "scandir", denied)
    try:
        assert watcher.add_tree(str(tmp_path), collect_files=True) == []
    finally:
        watcher.stop()

    assert any("cannot list" in message and "denied" in message for message in recorder.logs)


def test_feature_enable_retries_unchanged_ocr_and_semantic_candidates() -> None:
    """A later enable must revisit prior disabled OCR and partial-vector rows."""
    text_and_ocr = FeatureValues(False, True, True, False, False, False)
    text_and_semantic = FeatureValues(False, True, False, True, False, False)

    assert should_retry_unchanged("disabled:search_ocr", ".jpg", text_and_ocr)
    assert should_retry_unchanged("excluded:image_dir", ".jpg", text_and_ocr)
    assert should_retry_unchanged("no_text", ".pdf", text_and_ocr)
    assert should_retry_unchanged("partial", ".txt", text_and_semantic)
    assert not should_retry_unchanged("no_text", ".pdf", text_and_semantic)
