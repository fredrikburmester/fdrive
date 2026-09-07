"""The `rebuild_image_embeddings` pass and the small helpers that let
`GET /stats` report its progress under `image_embedding_rebuild`, mirroring
`thumb_rebuild.py`. Reuses `ThumbnailRebuildJob` as its bookkeeping type: the
class tracks nothing thumbnail-specific, it is just "one background job's
progress", already shared by the index-clear and thumbnail-clear jobs.

Requests to the sidecar are batched at `IMAGE_EMBED_BATCH_SIZE`
(`RootContext.cfg.image_embed_batch_size`): thumbnail bytes for up to that
many candidates are read and POSTed together, bounding both memory and the
number of HTTP round trips for a whole-root backfill.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Sequence

from . import db
from .image_embed import (
    dimension_guard,
    embed_images,
    image_embed_health,
    rebuild_needs_embedding,
    select_image_embed_candidates,
)
from .indexer import RootContext, log
from .thumb_rebuild import ThumbnailRebuildJob
from .thumbs import normalize_scope, storage_path


def rebuild_image_embeddings(
    root: RootContext,
    path: str | None = None,
    force: bool = False,
    on_file: Callable[[bool], None] | None = None,
) -> int:
    """Backfill (or, with `force`, replace stale-model) image embeddings for
    every live image in `root`, optionally scoped to `path` (a single file
    or a directory subtree; the whole root when omitted). A no-op returning
    0 when `IMAGE_EMBED_URL` is not configured or the sidecar fails the
    dimension/status guard -- this pass never partially writes a run whose
    guard failed. Returns the number of candidate files processed
    (successfully embedded or not)."""
    embed_url = root.cfg.image_embed_url
    if not embed_url:
        return 0
    conn = root.conn()
    health = image_embed_health(embed_url)
    guard = dimension_guard(health)
    if guard is not None:
        log(f"image embedding rebuild: {guard}; skipping")
        return 0
    assert health is not None  # dimension_guard is None only when health is present
    configured_model = health.model or ""

    rows = db.media_files(conn, root.root_id)
    candidates = select_image_embed_candidates(rows, normalize_scope(path))

    processed = 0
    pending: list[tuple[str, str]] = []

    def flush() -> None:
        nonlocal processed
        if not pending:
            return
        data: list[bytes] = []
        opened: list[str] = []
        for sha256, thumb_path in pending:
            try:
                with open(thumb_path, "rb") as fh:
                    data.append(fh.read())
                opened.append(sha256)
            except OSError as e:
                log(f"image embedding rebuild: cannot read thumbnail for {sha256}: {type(e).__name__}: {e}")

        succeeded: set[str] = set()
        if opened:
            try:
                embeddings, model = embed_images(data, embed_url, root.cfg.image_embed_batch_size)
                for sha256, vector in zip(opened, embeddings, strict=True):
                    db.upsert_image_embedding(conn, sha256, model, vector)
                    succeeded.add(sha256)
            except Exception as e:  # noqa: BLE001 - one bad batch must never stop the pass
                log(f"image embedding rebuild: embed request failed: {type(e).__name__}: {e}")

        for sha256, _thumb_path in pending:
            processed += 1
            if on_file is not None:
                on_file(sha256 in succeeded)
        pending.clear()

    batch_size = max(1, root.cfg.image_embed_batch_size)
    for _rel_path, _ext, sha256, _size in candidates:
        existing_model = db.image_embedding_model(conn, sha256)
        if not rebuild_needs_embedding(existing_model, configured_model, force):
            continue
        pending.append((sha256, os.path.join(root.cfg.thumbs_dir, storage_path(sha256, 256))))
        if len(pending) >= batch_size:
            flush()
    flush()
    return processed


def count_image_embed_candidates(contexts: Sequence[RootContext], path: str | None) -> int:
    """How many files `rebuild_image_embeddings(ctx, path, ...)` would
    consider across `contexts`, before filtering by existing rows or
    `force`. Used to answer `POST /image-embeddings/rebuild` with a total
    before the background pass has processed anything, matching
    `thumb_rebuild.count_candidates`."""
    scope = normalize_scope(path)
    return sum(len(select_image_embed_candidates(db.media_files(ctx.conn(), ctx.root_id), scope)) for ctx in contexts)


def start_image_embed_rebuild(
    job: ThumbnailRebuildJob,
    contexts: Sequence[RootContext],
    path: str | None,
    force: bool,
) -> int | None:
    """Start a background image-embedding rebuild across `contexts`.
    Returns the total candidate count, or `None` when a rebuild (of any
    kind sharing this job's admission lock) is already running, matching
    `thumb_rebuild.start_rebuild`. When `IMAGE_EMBED_URL` is not configured
    on any context, the total is reported as 0 up front rather than
    discovering candidates the pass will then never touch (it is a no-op,
    matching `rebuild_image_embeddings`)."""
    if not job.try_start(0):
        return None
    configured = any(ctx.cfg.image_embed_url for ctx in contexts)
    try:
        total = count_image_embed_candidates(contexts, path) if configured else 0
        job.discover(total)
    except Exception:
        job.fail()
        job.finish()
        raise

    def run() -> None:
        try:
            if configured:
                for ctx in contexts:
                    rebuild_image_embeddings(ctx, path, force, on_file=job.advance)
        except Exception as e:  # noqa: BLE001 - a crashed pass must still release the job
            job.fail()
            log(f"image embedding rebuild job crashed: {type(e).__name__}: {e}")
        finally:
            job.finish()

    try:
        threading.Thread(target=run, daemon=True, name="image-embed-rebuild").start()
    except Exception:
        job.fail()
        job.finish()
        raise
    return total
