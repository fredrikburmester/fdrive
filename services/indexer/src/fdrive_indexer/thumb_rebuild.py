"""The `rebuild_thumbnails` pass and the small in-memory job record that lets
`GET /stats` report its progress. This is I/O and threading orchestration: which
files qualify and whether a given size needs rewriting are pure decisions made in
`thumbs.py`; the actual pixels come from `thumbs_io.py`.

Unlike `POST /reindex`, this pass never touches `text_status`, `idx.chunks`, or
embeddings: it only regenerates `app.thumbnails` rows.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import db
from .indexer import RootContext, log
from .thumbs import normalize_scope, select_candidates
from .thumbs_io import generate as generate_thumbnails


@dataclass
class ThumbnailRebuildJob:
    """At most one rebuild runs at a time across the whole process. `try_start`
    is the only way `running` flips to `True`, so it doubles as the mutual
    exclusion check the `/thumbnails/rebuild` route uses to return 409."""

    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)
    admission: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)
    running: bool = False
    processed: int = 0
    total: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    errors: int = 0

    def try_start(self, total: int) -> bool:
        """Claim the job for a new run. Returns False (and changes nothing) if a
        run is already in progress."""
        if not self.admission.acquire(blocking=False):
            return False
        with self._lock:
            self.running = True
            self.processed = 0
            self.total = total
            self.errors = 0
            self.started_at = datetime.now().astimezone()
            self.finished_at = None
            return True

    def advance(self, ok: bool) -> None:
        with self._lock:
            self.processed += 1
            if not ok:
                self.errors += 1

    def discover(self, count: int) -> None:
        with self._lock:
            self.total += count

    def fail(self) -> None:
        with self._lock:
            self.errors += 1

    def finish(self) -> None:
        with self._lock:
            if self.running:
                self.running = False
                self.finished_at = datetime.now().astimezone()
                self.admission.release()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "processed": self.processed,
                "total": self.total,
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "finished_at": self.finished_at.isoformat() if self.finished_at else None,
                "errors": self.errors,
            }


def rebuild_thumbnails(
    root: RootContext,
    path: str | None = None,
    force: bool = False,
    on_file: Callable[[bool], None] | None = None,
) -> int:
    """Regenerate thumbnails for every live media file in `root`, optionally
    scoped to `path` (a single file or a directory subtree; the whole root when
    omitted). With `force`, both sizes are deleted and rewritten even when a
    thumbnail already exists for that sha256; otherwise only missing sizes are
    written. Returns the number of candidate files processed.

    Only `app.thumbnails` is written here: `text_status`, `idx.chunks`, and
    embeddings are never touched, unlike `POST /reindex`.
    """
    conn = root.conn()
    rows = db.media_files(conn, root.root_id)
    candidates = select_candidates(rows, normalize_scope(path))
    processed = 0
    for rel_path, ext, sha256, size in candidates:
        root.maybe_refresh_features()
        if not root.feature_configuration().values.internal_thumbnails:
            log("thumbnail rebuild stopped: feature disabled")
            break
        abs_path = os.path.join(root.abs_path, rel_path)
        ok = True
        try:
            results = generate_thumbnails(
                abs_path, ext, sha256, size, root.cfg.thumbs_dir, root.cfg.thumb_max_bytes, force=force, log=log
            )
            for out_size, rel_thumb_path, width, height in results:
                db.upsert_thumbnail(conn, sha256, out_size, rel_thumb_path, width, height)
        except Exception as e:  # noqa: BLE001 - one bad file must never stop the pass
            log(f"thumb rebuild: unexpected failure for {rel_path}: {type(e).__name__}: {e}")
            ok = False
        if on_file is not None:
            on_file(ok)
        processed += 1
    return processed


def count_candidates(contexts: Sequence[RootContext], path: str | None) -> int:
    """How many files `rebuild_thumbnails(ctx, path, ...)` would touch, summed
    across `contexts`. Used to answer `POST /thumbnails/rebuild` with a total
    before the background pass has processed anything."""
    scope = normalize_scope(path)
    return sum(len(select_candidates(db.media_files(ctx.conn(), ctx.root_id), scope)) for ctx in contexts)


def start_rebuild(
    job: ThumbnailRebuildJob,
    contexts: Sequence[RootContext],
    path: str | None,
    force: bool,
) -> int | None:
    """Start a background thumbnail rebuild across `contexts`. Returns the total
    candidate count, or `None` when a rebuild is already running (the caller
    should answer with 409 in that case)."""
    if not job.try_start(0):
        return None
    try:
        total = count_candidates(contexts, path)
        job.discover(total)
    except Exception:
        job.fail()
        job.finish()
        raise

    def run() -> None:
        try:
            for ctx in contexts:
                if not ctx.feature_configuration().values.internal_thumbnails:
                    continue
                rebuild_thumbnails(ctx, path, force, on_file=job.advance)
        except Exception as e:  # noqa: BLE001 - a crashed pass must still release the job
            job.fail()
            log(f"thumbnail rebuild job crashed: {type(e).__name__}: {e}")
        finally:
            job.finish()

    try:
        threading.Thread(target=run, daemon=True, name="thumbnail-rebuild").start()
    except Exception:
        job.fail()
        job.finish()
        raise
    return total
