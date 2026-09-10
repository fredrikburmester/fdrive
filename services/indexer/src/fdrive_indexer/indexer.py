"""Orchestration: walks a root, hashes and extracts changed files, chunks and embeds
text, generates thumbnails, applies watcher callbacks, and runs the periodic scan
that reconciles anything the watcher could not see.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime

import psycopg

from . import db
from .chunking import chunk, max_chunks_for
from .config import Config
from .events import build_event
from .extract import Extractor, embed_passages
from .features import FeatureConfiguration, FeatureValues, disabled
from .image_embed import dimension_guard, embed_images, image_embed_health, is_image_candidate, needs_embedding
from .paths import ext_of
from .rules import is_text_excluded, should_index_name, should_walk_dir
from .settings import Settings
from .thumbs import SIZES, kind_for_ext
from .thumbs import storage_path as thumb_storage_path
from .thumbs_io import generate as generate_thumbnails

mimetypes.add_type("application/vnd.apple.pages", ".pages")
mimetypes.add_type("application/vnd.apple.numbers", ".numbers")
mimetypes.add_type("application/vnd.apple.keynote", ".key")


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb", buffering=0) as fh:
        while True:
            block = fh.read(4 * 1024 * 1024)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def walk(
    root: str,
    skip_names: frozenset[str],
    skip_dirs: frozenset[str],
    on_error: Callable[[], None] | None = None,
) -> Iterator[tuple[str, str, os.stat_result]]:
    """Yield (abs_path, rel_path, stat) for regular files, sorted, skipping junk."""
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            entries = sorted(os.scandir(d), key=lambda entry: entry.name.lower())
        except OSError as exc:
            log(f"skip dir {d}: {exc}")
            if on_error is not None:
                on_error()
            continue
        subdirs = []
        for e in entries:
            name = e.name
            if not should_index_name(name, skip_names):
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    if should_walk_dir(name, skip_dirs):
                        subdirs.append(e.path)
                    continue
                if not e.is_file(follow_symlinks=False):
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError as err:
                log(f"skip {e.path}: {err}")
                if on_error is not None:
                    on_error()
                continue
            yield e.path, os.path.relpath(e.path, root), st
        stack.extend(reversed(subdirs))


def unchanged_in_db(manifest_row: tuple[int, int, str, object] | None, st: os.stat_result) -> bool:
    return (
        manifest_row is not None
        and manifest_row[0] == st.st_size
        and manifest_row[1] == st.st_mtime_ns
        and manifest_row[2] != "pending"
        and manifest_row[3] is None
    )


class PathLocks:
    """Serialises work on one path so the watcher and a running scan never interleave
    chunk writes for the same file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}

    def get(self, key: str) -> threading.Lock:
        with self._lock:
            lk = self._locks.get(key)
            if lk is None:
                lk = self._locks[key] = threading.Lock()
            return lk


@dataclass
class RootContext:
    """Everything one root needs to walk, index, and watch itself."""

    name: str
    root_id: int
    abs_path: str
    cfg: Config
    settings: Settings
    extractor: Extractor
    features: FeatureConfiguration = field(default_factory=lambda: FeatureConfiguration(0, disabled()))
    feature_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    feature_refresher: Callable[[RootContext], object] | None = field(default=None, repr=False)
    feature_refresh_seconds: float = 5.0
    _last_feature_refresh: float = 0.0
    _backfill_media: bool = False
    path_locks: PathLocks = field(default_factory=PathLocks)
    local: threading.local = field(default_factory=threading.local)

    def conn(self) -> psycopg.Connection:
        conn = getattr(self.local, "conn", None)
        if conn is None or conn.closed:
            conn = db.connect(self.cfg.database_url)
            self.local.conn = conn
        return conn

    def feature_configuration(self) -> FeatureConfiguration:
        with self.feature_lock:
            return self.features

    def set_features(self, value: FeatureConfiguration) -> bool:
        with self.feature_lock:
            old = self.features.values
            self.features = value
            enabled_media = value.values.internal_thumbnails and not old.internal_thumbnails
            enabled_image = value.values.image_search and not old.image_search
            self._backfill_media = self._backfill_media or enabled_media or enabled_image
            return old != value.values

    def needs_media_backfill(self) -> bool:
        with self.feature_lock:
            return self._backfill_media

    def finish_media_backfill(self) -> None:
        with self.feature_lock:
            self._backfill_media = False

    def maybe_refresh_features(self) -> None:
        refresher = self.feature_refresher
        if refresher is None:
            return
        with self.feature_lock:
            now = time.monotonic()
            if now - self._last_feature_refresh < self.feature_refresh_seconds:
                return
            self._last_feature_refresh = now
        refresher(self)


def process_file(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> bool:
    """Index one file. Returns False if this exact version is already indexed
    (a scan and the watcher raced on the same path; the second one to take the lock
    sees the first one's row and skips instead of extracting and embedding twice)."""
    with ctx.path_locks.get(rel_path):
        ctx.maybe_refresh_features()
        if not ctx.feature_configuration().values.indexer_enabled:
            return False
        conn = ctx.conn()
        with conn.cursor() as cur:
            cur.execute(
                'SELECT size, mtime_ns, text_status, deleted_at FROM "idx"."files" WHERE root_id = %s AND path = %s',
                (ctx.root_id, rel_path),
            )
            row = cur.fetchone()
        manifest_row = (row[0], row[1], row[2], row[3]) if row else None
        manifest_status = str(manifest_row[2]) if manifest_row is not None else ""
        if unchanged_in_db(manifest_row, st) and not should_retry_unchanged(
            manifest_status, ext_of(os.path.basename(rel_path)), ctx.feature_configuration().values
        ):
            return False
        was_new = manifest_row is None
        _process_file(ctx, abs_path, rel_path, st)
        emit_event(ctx, "created" if was_new else "changed", rel_path)
        return True


def should_retry_unchanged(status: str, ext: str, features: FeatureValues) -> bool:
    """Whether a feature transition makes this unchanged manifest row actionable."""
    from .chunking import is_image, is_pdf

    if status == "excluded:image_dir":
        return features.text_search and features.search_ocr
    if status == "disabled:text" or status.startswith("excluded"):
        return features.text_search
    if status == "disabled:search_ocr":
        return features.text_search and features.search_ocr
    if status == "no_text":
        return features.text_search and features.search_ocr and (is_image(ext) or is_pdf(ext))
    return status == "partial" and features.semantic_search


def _process_file(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> None:
    conn = ctx.conn()
    name = os.path.basename(rel_path)
    ext = ext_of(name)
    mime = mimetypes.guess_type(name)[0]
    sha = sha256_of(abs_path)
    file_id = db.upsert_file(conn, ctx.root_id, rel_path, name, ext, st.st_size, st.st_mtime_ns, sha, mime)

    from .chunking import is_image, is_textual

    features = ctx.feature_configuration().values
    if not features.text_search:
        status, text = "disabled:text", None
    elif is_image(ext) and not features.search_ocr:
        status, text = "disabled:search_ocr", None
    elif not is_textual(ext):
        status, text = "none", None
    elif is_text_excluded(ctx.name, rel_path, list(ctx.settings.text_exclude_globs)):
        status, text = "excluded:prefix", None
    else:
        text, status = ctx.extractor.extract(abs_path, rel_path, ext, st.st_size, search_ocr=features.search_ocr)

    chars = 0
    error = None
    if text and status == "indexed":
        chars = len(text)
        limit = max_chunks_for(ext, ctx.cfg.max_chunks_per_file)
        pieces = chunk(text, ctx.cfg.chunk_chars, ctx.cfg.chunk_overlap, limit)
        if features.semantic_search:
            try:
                vecs: list[list[float] | None] = list(embed_passages(pieces, ctx.cfg.embed_url, ctx.cfg.embed_batch))
            except Exception as e:  # noqa: BLE001 - keep text searchable via FTS, retry embeddings next scan
                log(f"embed failed for {rel_path}: {e}")
                vecs = [None] * len(pieces)
                error = f"embed:{type(e).__name__}"
                status = "partial"
        else:
            # Keep FTS chunks but leave vectors pending so an enable can backfill
            # unchanged files without a destructive rebuild.
            vecs = [None] * len(pieces)
            status = "partial"
        db.insert_chunks(conn, file_id, pieces, vecs)
    elif status.startswith("error:"):
        error = status[6:]
        status = "error"
    elif status.startswith("excluded:"):
        error = status
        status = "excluded"

    db.update_file_status(conn, file_id, status, chars, error)

    if features.internal_thumbnails:
        try:
            thumbs = generate_thumbnails(abs_path, ext, sha, st.st_size, ctx.cfg.thumbs_dir, ctx.cfg.thumb_max_bytes, log=log)
            for size, rel_thumb_path, width, height in thumbs:
                db.upsert_thumbnail(conn, sha, size, rel_thumb_path, width, height)
        except Exception as e:  # noqa: BLE001 - thumbnails never fail the file
            log(f"thumb: unexpected failure for {rel_path}: {type(e).__name__}: {e}")

    if features.image_search and is_image_candidate(ext):
        try:
            embed_thumbnail(ctx, sha)
        except Exception as e:  # noqa: BLE001 - image embedding never fails the file
            log(f"image embed: unexpected failure for {rel_path}: {type(e).__name__}: {e}")


def embed_thumbnail(ctx: RootContext, sha256: str) -> bool:
    """Embeds a file's 256px thumbnail through the image-embed sidecar and
    upserts the vector under `sha256`, unless it already has a row for the
    currently configured model. A no-op when `IMAGE_EMBED_URL` is not
    configured, when the sidecar fails the dimension/status guard, or when
    the 256px thumbnail was never written (e.g. it was over the thumbnail
    size budget)."""
    embed_url = ctx.cfg.image_embed_url
    if not embed_url:
        return False
    health = image_embed_health(embed_url)
    guard = dimension_guard(health)
    if guard is not None:
        log(f"image embed: {guard}; skipping")
        return False
    assert health is not None  # dimension_guard is None only when health is present
    configured_model = health.model or ""

    conn = ctx.conn()
    existing_model = db.image_embedding_model(conn, sha256)
    if not needs_embedding(existing_model, configured_model):
        return True

    thumb_path = os.path.join(ctx.cfg.thumbs_dir, thumb_storage_path(sha256, 256))
    try:
        with open(thumb_path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        # Thumbnailing already logged why nothing was written (unsupported
        # format, over budget); a second error for the same file is noise.
        return False
    except OSError as e:
        log(f"image embed: cannot read thumbnail {thumb_path}: {type(e).__name__}: {e}")
        return False

    embeddings, model = embed_images([data], embed_url, ctx.cfg.image_embed_batch_size)
    if embeddings:
        db.upsert_image_embedding(conn, sha256, model, embeddings[0])
        return True
    return False


def backfill_media(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> bool:
    """Populate newly enabled media derivatives without touching indexed text.

    A false result keeps the root's backfill pending; the next normal scan then
    retries only the derivatives that remain unavailable or failed.
    """
    features = ctx.feature_configuration().values
    if not features.internal_thumbnails:
        return True
    ext = ext_of(os.path.basename(rel_path))
    sha = sha256_of(abs_path)
    ok = True
    try:
        thumbs = generate_thumbnails(abs_path, ext, sha, st.st_size, ctx.cfg.thumbs_dir, ctx.cfg.thumb_max_bytes, log=log)
        for size, rel_thumb_path, width, height in thumbs:
            db.upsert_thumbnail(ctx.conn(), sha, size, rel_thumb_path, width, height)
    except Exception as e:  # noqa: BLE001
        log(f"thumb backfill: unexpected failure for {rel_path}: {type(e).__name__}: {e}")
        ok = False
    if features.image_search and is_image_candidate(ext):
        try:
            ok = embed_thumbnail(ctx, sha) and ok
        except Exception as e:  # noqa: BLE001
            log(f"image embed backfill: unexpected failure for {rel_path}: {type(e).__name__}: {e}")
            ok = False
    return ok


def media_derivatives_missing(ctx: RootContext, rel_path: str) -> bool:
    """Whether a live file needs enabled, durable media output rebuilt.

    This predicate makes work survive an indexer restart and a failed first
    attempt: derivative files and image-embedding rows are the durable state,
    while ``_backfill_media`` merely accelerates a feature transition.
    """
    features = ctx.feature_configuration().values
    if not features.internal_thumbnails:
        return False
    ext = ext_of(os.path.basename(rel_path))
    key = db.file_content_key(ctx.conn(), ctx.root_id, rel_path)
    if key is None:
        return False
    if kind_for_ext(ext) is not None:
        if any(not os.path.exists(os.path.join(ctx.cfg.thumbs_dir, thumb_storage_path(key, size))) for size in SIZES):
            return True
    return features.image_search and is_image_candidate(ext) and db.image_embedding_model(ctx.conn(), key) is None


def embed_missing(ctx: RootContext, rel_path: str) -> None:
    """Fill in embeddings for a file whose text is already chunked (status 'partial')."""
    with ctx.path_locks.get(rel_path):
        ctx.maybe_refresh_features()
        if not ctx.feature_configuration().values.semantic_search:
            return
        conn = ctx.conn()
        rows = db.chunks_missing_embeddings(conn, ctx.root_id, rel_path)
        if rows:
            vecs = embed_passages([t for _, t in rows], ctx.cfg.embed_url, ctx.cfg.embed_batch)
            db.set_chunk_embeddings(conn, [(cid, v) for (cid, _), v in zip(rows, vecs, strict=True)])
        db.mark_file_indexed(conn, ctx.root_id, rel_path)


def safe_process(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> str:
    """`process_file` on this thread's connection -> "indexed" | "unchanged" | "error".
    A failure is logged and recorded on the row."""
    try:
        return "indexed" if process_file(ctx, abs_path, rel_path, st) else "unchanged"
    except Exception as e:  # noqa: BLE001
        log(f"ERROR {rel_path}: {type(e).__name__}: {e}")
        try:
            db.mark_file_error(ctx.conn(), ctx.root_id, rel_path, f"{type(e).__name__}: {str(e)[:300]}")
        except Exception:  # noqa: BLE001
            pass
        return "error"


def emit_event(ctx: RootContext, kind: str, rel_path: str, target_path: str | None = None) -> None:
    event = build_event(kind, ctx.name, rel_path, target_path)  # type: ignore[arg-type]
    try:
        db.record_event(ctx.conn(), ctx.root_id, event)
    except Exception as e:  # noqa: BLE001 - an event failure must never break indexing
        log(f"event: failed to record {kind} for {rel_path}: {type(e).__name__}: {e}")


# -- watcher callbacks --------------------------------------------------------------------


def watch_index(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> str:
    ctx.maybe_refresh_features()
    if not ctx.feature_configuration().values.indexer_enabled:
        return "disabled"
    return safe_process(ctx, abs_path, rel_path, st)


def watch_mark_deleted(ctx: RootContext, rel_path: str, is_dir: bool) -> int:
    if not ctx.feature_configuration().values.indexer_enabled:
        return 0
    ids = db.mark_deleted(ctx.conn(), ctx.root_id, rel_path, is_dir)
    if ids:
        emit_event(ctx, "deleted", rel_path)
    return len(ids)


def watch_rename(ctx: RootContext, old_rel: str, new_rel: str, is_dir: bool) -> int:
    if not ctx.feature_configuration().values.indexer_enabled:
        return 0
    if not is_dir and ext_of(os.path.basename(old_rel)) != ext_of(os.path.basename(new_rel)):
        watch_mark_deleted(ctx, old_rel, False)
        return 0
    moved = db.rename_paths(ctx.conn(), ctx.root_id, old_rel, new_rel, is_dir)
    if moved:
        db.insert_moves(ctx.conn(), ctx.root_id, old_rel, new_rel, "watcher")
        emit_event(ctx, "moved", old_rel, new_rel)
    return moved


def start_watcher(ctx: RootContext, workers: int, debounce: float) -> object | None:
    if not ctx.cfg.watch:
        return None
    try:
        from .watcher import Watcher

        w = Watcher(
            ctx.abs_path,
            log,
            lambda a, r, s: watch_index(ctx, a, r, s),
            lambda r, d: watch_mark_deleted(ctx, r, d),
            lambda o, n, d: watch_rename(ctx, o, n, d),
            workers=workers,
            debounce=debounce,
        )
        w.start()
        log(f"[{ctx.name}] watching {w.dirs} directories for changes (debounce {debounce:g}s)")
        return w
    except Exception as e:  # noqa: BLE001
        log(f"[{ctx.name}] watcher unavailable ({type(e).__name__}: {e}); relying on periodic scans only")
        return None


def scan_once(ctx: RootContext) -> dict[str, int]:
    ctx.maybe_refresh_features()
    if not ctx.feature_configuration().values.indexer_enabled:
        return {"seen": 0, "changed": 0, "deleted": 0, "errors": 0}
    try:
        with os.scandir(ctx.abs_path):
            pass
    except OSError as error:
        log(f"[{ctx.name}] scan skipped: root unavailable: {error}")
        return {"seen": 0, "changed": 0, "deleted": 0, "errors": 1}
    conn = ctx.conn()
    scan_id, started = db.start_scan(conn, ctx.root_id)
    manifest = db.get_manifest(conn, ctx.root_id)

    seen: list[str] = []
    counters = {"changed": 0, "errors": 0}
    media_backfill_errors = 0
    n = 0
    t0 = time.time()
    workers = ctx.settings.workers
    lock = threading.Lock()

    def job(abs_path: str, rel_path: str, st: os.stat_result, embed_only: bool = False, media_only: bool = False) -> None:
        nonlocal media_backfill_errors
        ctx.maybe_refresh_features()
        if not ctx.feature_configuration().values.indexer_enabled:
            return
        if media_only:
            if not backfill_media(ctx, abs_path, rel_path, st):
                with lock:
                    media_backfill_errors += 1
            if not embed_only:
                return
        if embed_only:
            if not ctx.feature_configuration().values.semantic_search:
                return
            try:
                embed_missing(ctx, rel_path)
                ok = True
            except Exception as e:  # noqa: BLE001
                log(f"[{ctx.name}] embed retry failed for {rel_path}: {type(e).__name__}: {e}")
                ok = False
        else:
            result = safe_process(ctx, abs_path, rel_path, st)
            if result == "unchanged":
                return
            ok = result == "indexed"
        with lock:
            counters["changed" if ok else "errors"] += 1

    traversal_complete = True

    def traversal_error() -> None:
        nonlocal traversal_complete
        traversal_complete = False

    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = []
        for abs_path, rel_path, st in walk(ctx.abs_path, ctx.cfg.skip_names, ctx.cfg.skip_dirs, traversal_error):
            n += 1
            seen.append(rel_path)
            prev = manifest.get(rel_path)
            unchanged = prev is not None and prev[0] == st.st_size and prev[1] == st.st_mtime_ns and prev[3] is None
            ctx.maybe_refresh_features()
            if not ctx.feature_configuration().values.indexer_enabled:
                traversal_complete = False
                break
            features = ctx.feature_configuration().values
            media_needed = unchanged and (ctx.needs_media_backfill() or media_derivatives_missing(ctx, rel_path))
            retry_unchanged = prev is not None and should_retry_unchanged(prev[2], ext_of(os.path.basename(rel_path)), features)
            if unchanged and prev is not None and prev[2] == "partial" and features.semantic_search:
                pending.append(pool.submit(job, abs_path, rel_path, st, True, media_needed))
            elif unchanged and retry_unchanged:
                pending.append(pool.submit(job, abs_path, rel_path, st))
            elif media_needed:
                pending.append(pool.submit(job, abs_path, rel_path, st, False, True))
            elif unchanged and prev is not None and prev[2] not in ("pending", "disabled:text", "disabled:search_ocr"):
                continue
            else:
                pending.append(pool.submit(job, abs_path, rel_path, st))
            if len(pending) >= workers * 8:
                pending[0].result()
                pending = [f for f in pending if not f.done()]
        for f in pending:
            f.result()

    deleted = db.sweep_vanished(conn, ctx.root_id, seen, started) if traversal_complete else 0
    if traversal_complete and ctx.needs_media_backfill() and not media_backfill_errors:
        ctx.finish_media_backfill()
    db.finish_scan(conn, scan_id, n, counters["changed"], deleted, counters["errors"])
    db.prune_events(conn, ctx.cfg.events_retention_days)
    log(
        f"[{ctx.name}] scan done: {n} files, {counters['changed']} (re)indexed, {deleted} deleted, "
        f"{counters['errors']} errors, {time.time() - t0:.0f}s"
    )
    return {"seen": n, "changed": counters["changed"], "deleted": deleted, "errors": counters["errors"]}


def wait_for_embed(embed_url: str, log_fn: Callable[[str], None] = log, sleep: Callable[[float], None] = time.sleep) -> bool:
    from .extract import embed_health

    for _ in range(300):
        if embed_health(embed_url):
            return True
        sleep(5)
    log_fn("embedding service still not healthy after 25 min; continuing anyway (FTS only)")
    return False
