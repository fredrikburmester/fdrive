"""Bounded background maintenance passes. Original files are never opened."""

from __future__ import annotations

import os
import re
import stat
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager

import psycopg

from .indexer import RootContext, log
from .thumb_rebuild import ThumbnailRebuildJob

BATCH_SIZE = 250
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_PREVIEW = re.compile(r"([0-9a-f]{64})\.(256|1024)\.webp\Z")


def clear_index(contexts: Sequence[RootContext], scope: str | None, job: ThumbnailRebuildJob) -> None:
    for ctx in contexts:
        conn = ctx.conn()
        after = 0
        with conn.cursor() as cur:
            cur.execute("SELECT coalesce(max(id), 0) FROM idx.files WHERE root_id = %s", (ctx.root_id,))
            row = cur.fetchone()
            assert row is not None
            upper = int(row[0])
        while True:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, path FROM idx.files WHERE root_id = %s AND id > %s AND id <= %s "
                    "AND (%s::text IS NULL OR path = %s OR starts_with(path, %s)) ORDER BY id LIMIT %s",
                    (ctx.root_id, after, upper, scope, scope, scope + "/" if scope else None, BATCH_SIZE),
                )
                rows = cur.fetchall()
            if not rows:
                break
            job.discover(len(rows))
            for file_id, path in rows:
                after = file_id
                try:
                    with ctx.path_locks.get(path), conn.cursor() as cur:
                        cur.execute(
                            "DELETE FROM idx.files WHERE root_id = %s AND id = %s AND path = %s", (ctx.root_id, file_id, path)
                        )
                except Exception as exc:
                    log(f"index clear failed for {path}: {exc}")
                    job.advance(False)
                else:
                    job.advance(True)


@contextmanager
def directory_fd(path: str) -> Iterator[int]:
    """Open each absolute component without following symlinks, including ancestors."""
    fd = os.open("/", _DIRECTORY_FLAGS)
    try:
        for part in os.path.abspath(path).split("/"):
            if part:
                child = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
        yield fd
    finally:
        os.close(fd)


def remove_preview(cache_fd: int | None, relative: str) -> None:
    """Unlink a regular cache file through pinned directories. Missing is success."""
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts) or "\x00" in relative or "\\" in relative:
        raise ValueError("unsafe thumbnail storage path")
    if cache_fd is None:
        return
    fd = os.dup(cache_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        entry = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(entry.st_mode):
            raise ValueError("thumbnail is not a regular file")
        os.unlink(parts[-1], dir_fd=fd)
    except FileNotFoundError:
        pass
    finally:
        os.close(fd)


def orphan_previews(cache_fd: int, job: ThumbnailRebuildJob) -> Iterator[str]:
    """Only the generated two-level SHA-256 layout qualifies as an orphan preview."""
    for shard in os.listdir(cache_fd):
        if re.fullmatch("[0-9a-f]{2}", shard) is None:
            continue
        try:
            fd = os.open(shard, _DIRECTORY_FLAGS, dir_fd=cache_fd)
        except FileNotFoundError:
            continue
        except OSError as exc:
            log(f"cannot inspect thumbnail shard {shard}: {exc}")
            job.discover(1)
            job.advance(False)
            continue
        try:
            for name in os.listdir(fd):
                match = _PREVIEW.fullmatch(name)
                if match is not None and match[1].startswith(shard):
                    yield f"{shard}/{name}"
        finally:
            os.close(fd)


def clear_cache(conn: psycopg.Connection, cache_fd: int | None, job: ThumbnailRebuildJob) -> None:
    after = ("", 0)
    with conn.cursor() as cur:
        cur.execute("SELECT content_key, size FROM app.thumbnails ORDER BY content_key DESC, size DESC LIMIT 1")
        row = cur.fetchone()
        upper = (str(row[0]), int(row[1])) if row else after
    while True:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT content_key, size, storage_path FROM app.thumbnails "
                "WHERE (content_key, size) > (%s, %s) AND (content_key, size) <= (%s, %s) "
                "ORDER BY content_key, size LIMIT %s",
                (*after, *upper, BATCH_SIZE),
            )
            rows = cur.fetchall()
        if not rows:
            break
        job.discover(len(rows))
        for key, size, relative in rows:
            after = (key, size)
            try:
                remove_preview(cache_fd, relative)
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM app.thumbnails WHERE content_key = %s AND size = %s AND storage_path = %s",
                        (key, size, relative),
                    )
            except Exception as exc:
                log(f"thumbnail clear failed for {relative}: {exc}")
                job.advance(False)
            else:
                job.advance(True)
    if cache_fd is None:
        return
    for relative in orphan_previews(cache_fd, job):
        # Failed manifest entries remain retryable, without counting or removing them twice.
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM app.thumbnails WHERE storage_path = %s LIMIT 1", (relative,))
            if cur.fetchone() is not None:
                continue
        job.discover(1)
        try:
            remove_preview(cache_fd, relative)
        except Exception as exc:
            log(f"orphan thumbnail clear failed for {relative}: {exc}")
            job.advance(False)
        else:
            job.advance(True)


def clear_thumbnails(contexts: Sequence[RootContext], job: ThumbnailRebuildJob) -> None:
    if not contexts:
        return
    ctx = contexts[0]
    # All production roots share Config and its single cache directory.
    with ExitStack() as stack:
        try:
            fd: int | None = stack.enter_context(directory_fd(ctx.cfg.thumbs_dir))
        except FileNotFoundError:
            fd = None
        clear_cache(ctx.conn(), fd, job)


def start_clear(job: ThumbnailRebuildJob, operation: Callable[[], None]) -> bool:
    if not job.try_start(0):
        return False

    def run() -> None:
        try:
            operation()
        except Exception as exc:
            job.fail()
            log(f"clear job failed: {type(exc).__name__}: {exc}")
        finally:
            job.finish()

    try:
        threading.Thread(target=run, daemon=True, name="indexer-clear").start()
    except Exception:
        job.fail()
        job.finish()
        raise
    return True
