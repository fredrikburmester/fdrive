from __future__ import annotations

import errno
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from fdrive_indexer.directory_listing import directory_parts, directory_query, list_directory


@pytest.mark.parametrize(
    "path", ["", "relative", "//", "/a/", "/a//b", "/.", "/a/../b", "/a\\b", "/\x00", "/\x7f", "/" + "a" * 4096]
)
def test_invalid_paths(path: str) -> None:
    with pytest.raises(ValueError):
        directory_parts(path)


def test_valid_paths_and_queries() -> None:
    assert directory_parts("/") == []
    assert directory_parts("/文 space/literal%20/%2F/%2e%2e") == ["文 space", "literal%20", "%2F", "%2e%2e"]
    assert directory_query([("path", "/"), ("root", "sftpgo")]) == ("sftpgo", "/")


@pytest.mark.parametrize(
    "fields",
    [
        [],
        [("root", "r")],
        [("root", "r"), ("root", "r")],
        [("root", "r"), ("wat", "/")],
        [("root", "r"), ("path", "/"), ("path", "/")],
        [("root", ""), ("path", "/")],
        [("root", "a" * 256), ("path", "/")],
        [("root", "\x01"), ("path", "/")],
        [("root", "r"), ("path", "/..")],
    ],
)
def test_invalid_queries(fields: list[tuple[str, str]]) -> None:
    with pytest.raises(ValueError):
        directory_query(fields)


def test_kinds_sorted_and_exact_names(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "directory").mkdir()
    for name in ["文 space", "literal%20", "literal%2F"]:
        (root / name).touch()
    (root / "symlink").symlink_to(tmp_path)
    (root / "broken").symlink_to(tmp_path / "absent")
    os.mkfifo(root / "fifo")
    assert list_directory(str(root), "/") == {
        "items": [
            {"name": "broken", "kind": "symlink"},
            {"name": "directory", "kind": "dir"},
            {"name": "fifo", "kind": "other"},
            {"name": "literal%20", "kind": "file"},
            {"name": "literal%2F", "kind": "file"},
            {"name": "symlink", "kind": "symlink"},
            {"name": "文 space", "kind": "file"},
        ],
        "overflow": False,
    }
    assert list_directory(str(root), "/directory") == {"items": [], "overflow": False}
    trusted = tmp_path / "trusted"
    trusted.symlink_to(root)
    assert list_directory(str(trusted), "/directory") == {"items": [], "overflow": False}


def test_refuses_symlinks_files_missing_and_closes_descriptors(tmp_path: Path) -> None:
    (tmp_path / "dir").mkdir()
    (tmp_path / "file").touch()
    (tmp_path / "link").symlink_to(tmp_path / "dir")
    real_open = os.open
    opened: list[int] = []

    def record_open(path: str, flags: int, *, dir_fd: int | None = None) -> int:
        fd = real_open(path, flags, dir_fd=dir_fd)
        opened.append(fd)
        return fd

    with patch("fdrive_indexer.directory_listing.os.open", side_effect=record_open):
        for path in ["/link", "/link/child", "/file", "/absent", "/dir/absent"]:
            with pytest.raises(OSError):
                list_directory(str(tmp_path), path)
    for fd in opened:
        with pytest.raises(OSError, match="Bad file descriptor"):
            os.fstat(fd)
    with pytest.raises(FileNotFoundError):
        list_directory(str(tmp_path / "absent"), "/")
    with pytest.raises(ValueError):
        list_directory(str(tmp_path), "/../escape")


def test_open_directory_survives_intermediate_swap_without_following_replacement(tmp_path: Path) -> None:
    root, outside = tmp_path / "root", tmp_path / "outside"
    (root / "parent" / "child").mkdir(parents=True)
    (outside / "child").mkdir(parents=True)
    (outside / "child" / "secret").touch()
    (root / "parent" / "child" / "inside").touch()
    real_open = os.open

    def swap(path: str, flags: int, *, dir_fd: int | None = None) -> int:
        fd = real_open(path, flags, dir_fd=dir_fd)
        if path == "parent":
            (root / "parent").rename(root / "original")
            (root / "parent").symlink_to(outside)
        return fd

    with patch("fdrive_indexer.directory_listing.os.open", side_effect=swap):
        assert list_directory(str(root), "/parent/child") == {"items": [{"name": "inside", "kind": "file"}], "overflow": False}
    with pytest.raises(OSError):
        list_directory(str(root), "/parent/child")


def test_boundaries_stop_scan_and_close_iterator(tmp_path: Path) -> None:
    for index in range(10002):
        (tmp_path / str(index)).touch()
    real_scandir = os.scandir
    counts = {"next": 0, "closed": False}

    class TrackedScan:
        def __init__(self, fd: int) -> None:
            self.entries = real_scandir(fd)

        def __enter__(self) -> TrackedScan:
            return self

        def __exit__(self, *args: object) -> None:
            self.entries.close()
            counts["closed"] = True

        def __iter__(self) -> TrackedScan:
            return self

        def __next__(self) -> os.DirEntry[str]:
            counts["next"] += 1
            assert counts["next"] <= 10001
            return next(self.entries)

    with patch("fdrive_indexer.directory_listing.os.scandir", side_effect=TrackedScan):
        result = list_directory(str(tmp_path), "/")
    assert len(result["items"]) == 10000
    assert result["items"] == sorted(result["items"], key=lambda entry: entry["name"])
    assert result["overflow"] is True
    assert counts == {"next": 10001, "closed": True}
    (tmp_path / "10001").unlink()
    assert list_directory(str(tmp_path), "/")["overflow"] is True
    (tmp_path / "10000").unlink()
    assert list_directory(str(tmp_path), "/")["overflow"] is False


def test_scandir_failure_closes_descriptor(tmp_path: Path) -> None:
    with patch("fdrive_indexer.directory_listing.os.scandir", side_effect=PermissionError(errno.EACCES, "secret path")):
        with patch("fdrive_indexer.directory_listing.os.close", wraps=os.close) as close:
            with pytest.raises(PermissionError):
                list_directory(str(tmp_path), "/")
            close.assert_called_once()
            with pytest.raises(OSError):
                os.fstat(close.call_args.args[0])


def test_iteration_error_closes_iterator_and_descriptor(tmp_path: Path) -> None:
    real_scandir = os.scandir
    closed = []
    entry = Mock()
    entry.is_symlink.side_effect = OSError(errno.EIO, "private")

    @contextmanager
    def failed_scan(fd: int) -> Iterator[Iterator[Mock]]:
        with real_scandir(fd):
            try:
                yield iter([entry])
            finally:
                closed.append(True)

    with patch("fdrive_indexer.directory_listing.os.scandir", side_effect=failed_scan):
        with patch("fdrive_indexer.directory_listing.os.close", wraps=os.close) as close:
            with pytest.raises(OSError):
                list_directory(str(tmp_path), "/")
            assert closed == [True]
            close.assert_called_once()
            with pytest.raises(OSError):
                os.fstat(close.call_args.args[0])
