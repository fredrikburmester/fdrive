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
from uuid import uuid4

from . import db, failures
from .indexer import RootContext, log
from .thumbs import SIZES, normalize_scope, select_candidates, skip_reason
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
    skipped: int = 0
    total_known: bool = False
    outcome: str | None = None
    revision: int = 0
    run_id: str = ""
    # The one root a run is confined to; None when it spans several roots.
    root: str | None = None

    def try_start(self, total: int, root: str | None = None) -> bool:
        """Claim the job for a new run. Returns False (and changes nothing) if a
        run is already in progress."""
        if not self.admission.acquire(blocking=False):
            return False
        with self._lock:
            self.running = True
            self.root = root
            self.processed = 0
            self.total = total
            self.errors = 0
            self.skipped = 0
            self.total_known = False
            self.outcome = None
            self.run_id = str(uuid4())
            self.started_at = datetime.now().astimezone()
            self.finished_at = None
            return True

    def advance(self, ok: bool, skipped: bool = False) -> None:
        with self._lock:
            self.processed += 1
            self.skipped += int(skipped)
            if not ok:
                self.errors += 1

    def discover(self, count: int) -> None:
        with self._lock:
            self.total += count

    def discovered(self) -> None:
        with self._lock:
            self.total_known = True

    def fail(self) -> None:
        with self._lock:
            self.errors += 1
            self.outcome = "failed"

    def finish(self) -> None:
        with self._lock:
            if self.running:
                self.running = False
                self.outcome = self.outcome or (
                    "failed" if self.errors else "stopped" if self.total_known and self.processed < self.total else "completed"
                )
                self.finished_at = datetime.now().astimezone()
                self.admission.release()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "processed": self.processed,
                "total": self.total,
                "total_known": self.total_known,
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "finished_at": self.finished_at.isoformat() if self.finished_at else None,
                "errors": self.errors,
                "outcome": self.outcome,
            }


    def activity_snapshot(self, kind: str, features: list[str]) -> dict[str, Any] | None:
        with self._lock:
            if self.started_at is None:
                return None
            return {
                "id": self.run_id, "kind": kind, "features": features, "root": self.root, "revision": self.revision,
                "state": "running" if self.running else self.outcome or "completed",
                "phase": "processing" if self.total_known or self.processed else "discovering",
                "processed": self.processed, "total": self.total if self.total_known else None,
                "errors": self.errors, "skipped": self.skipped,
                "unit": "entries" if kind.endswith("Clear") else "files",
                "startedAt": self.started_at.isoformat(),
                "finishedAt": self.finished_at.isoformat() if self.finished_at else None,
            }


def rebuild_thumbnails(
    root: RootContext,
    path: str | None = None,
    force: bool = False,
    on_file: Callable[[bool], None] | None = None,
    candidates: list[tuple[str, str, str, int]] | None = None,
    on_skip: Callable[[], None] | None = None,
) -> int:
    """Regenerate thumbnails for every live media file in `root`, optionally
    scoped to `path` (a single file or a directory subtree; the whole root when
    omitted). With `force`, both sizes are deleted and rewritten even when a
    thumbnail already exists for that sha256; otherwise only missing sizes are
    written. Returns the number of candidate files processed, including policy
    skips. `on_file` reports whether both sizes were saved; policy skips call
    `on_skip` instead, so they are not counted as successes or failures.

    Writes thumbnails and their failure history. `text_status`, `idx.chunks`,
    and embeddings are never touched, unlike `POST /reindex`.
    """
    conn = root.conn()
    if candidates is None:
        candidates = select_candidates(db.media_files(conn, root.root_id), normalize_scope(path))
    processed = 0
    for rel_path, ext, sha256, size in candidates:
        root.maybe_refresh_features()
        if not root.feature_configuration().values.internal_thumbnails:
            log("thumbnail rebuild stopped: feature disabled")
            break
        abs_path = os.path.join(root.abs_path, rel_path)
        reason = skip_reason(size, root.cfg.thumb_max_bytes)
        if reason is not None:
            log(f"thumb rebuild: skip {rel_path}: {reason}")
            if on_skip is not None:
                on_skip()
            processed += 1
            continue
        ok = True
        reasons: list[str] = []
        nothing_to_render: list[str] = []
        try:
            results = generate_thumbnails(
                abs_path, ext, sha256, size, root.cfg.thumbs_dir, root.cfg.thumb_max_bytes,
                force=force, log=log, on_error=reasons.append, on_skip=nothing_to_render.append
            )
            if nothing_to_render:
                failures.report(root, rel_path, "thumbnails", log, skipped=True, resolves=True)
                if on_skip is not None:
                    on_skip()
                processed += 1
                continue
            for out_size, rel_thumb_path, width, height in results:
                db.upsert_thumbnail(conn, sha256, out_size, rel_thumb_path, width, height)
            # Generation deliberately catches per-file errors. Empty or partial
            # output is a failure even though no exception reached this caller.
            ok = {result[0] for result in results} == set(SIZES)
        except Exception as e:  # noqa: BLE001 - one bad file must never stop the pass
            log(f"thumb rebuild: unexpected failure for {rel_path}: {type(e).__name__}: {e}")
            reasons.append(failures.describe(e))
            ok = False
        failures.report(root, rel_path, "thumbnails", log,
                        None if ok else reasons[0] if reasons else "Incomplete thumbnail: required sizes were not saved")
        if on_file is not None:
            on_file(ok)
        processed += 1
    return processed


def count_candidates(contexts: Sequence[RootContext], path: str | None) -> int:
    """How many files `rebuild_thumbnails(ctx, path, ...)` would touch, summed
    across `contexts`. This synchronous helper is for callers that need an
    inventory count; HTTP rebuild admission discovers candidates asynchronously."""
    scope = normalize_scope(path)
    return sum(len(select_candidates(db.media_files(ctx.conn(), ctx.root_id), scope)) for ctx in contexts)


def single_root(contexts: Sequence[RootContext]) -> str | None:
    """The root a job is confined to, or None when it touches several."""
    return contexts[0].name if len(contexts) == 1 else None


def start_rebuild(
    job: ThumbnailRebuildJob,
    contexts: Sequence[RootContext],
    path: str | None,
    force: bool,
) -> bool:
    """Claim admission and start discovery in the background. False means busy.

    Candidate discovery can take longer than the API timeout. The HTTP caller
    acknowledges with an unknown total; stats/activity expose it after discovery.
    """
    if not job.try_start(0, single_root(contexts)):
        return False
    job.revision = max((ctx.feature_configuration().revision for ctx in contexts), default=0)

    def run() -> None:
        try:
            candidates = [
                (ctx, select_candidates(db.media_files(ctx.conn(), ctx.root_id), normalize_scope(path)))
                for ctx in contexts
            ]
            job.discover(sum(len(rows) for _, rows in candidates))
            job.discovered()
            for ctx, rows in candidates:
                if not ctx.feature_configuration().values.internal_thumbnails:
                    continue
                with failures.attempt({"thumbnails": job.run_id}):
                    rebuild_thumbnails(
                        ctx, path, force, on_file=job.advance, candidates=rows,
                        on_skip=lambda: job.advance(True, skipped=True),
                    )
                failures.prune(ctx.conn())
        except Exception as e:  # noqa: BLE001 - a crashed pass must still release the job
            job.fail()
            log(f"thumbnail-rebuild job crashed: {type(e).__name__}: {e}")
        finally:
            job.finish()

    try:
        threading.Thread(target=run, daemon=True, name="thumbnail-rebuild").start()
    except Exception:
        job.fail()
        job.finish()
        raise
    return True
