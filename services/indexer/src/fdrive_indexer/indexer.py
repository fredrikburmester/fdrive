"""Orchestration: walks a root, hashes and extracts changed files, chunks and embeds
text, generates thumbnails, applies watcher callbacks, and runs the periodic scan
that reconciles anything the watcher could not see.
"""

from __future__ import annotations

import errno
import hashlib
import mimetypes
import os
import queue
import stat
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from dataclasses import dataclass, field, replace

import psycopg

from . import db, failures
from .activity import Operation, RootActivity
from .chunking import chunk, max_chunks_for
from .config import Config
from .diagnostic_log import log as log
from .embed_backoff import EmbedBackoff, is_backend_outage
from .events import build_event
from .extract import Extractor, embed_passages
from .features import FeatureConfiguration, FeatureValues, disabled
from .image_embed import (
    ImageEmbedHealth,
    dimension_guard,
    embed_images,
    image_embed_health,
    is_image_candidate,
    needs_embedding,
)
from .paths import ext_of
from .rules import is_ocr_image_dir, is_text_excluded, should_index_name, should_walk_dir
from .settings import Settings
from .thumbs import SIZES, kind_for_ext, skip_reason, within_size_budget
from .thumbs import storage_path as thumb_storage_path
from .thumbs_io import generate as generate_thumbnails

mimetypes.add_type("application/vnd.apple.pages", ".pages")
mimetypes.add_type("application/vnd.apple.numbers", ".numbers")
mimetypes.add_type("application/vnd.apple.keynote", ".key")

_FILE_READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

# Classified files a scan holds before traversal waits for workers, about 1 KB each.
# Large enough that most scans finish discovery, and report a total, early.
SCAN_BACKLOG_LIMIT = 20_000


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    descriptor = os.open(path, _FILE_READ_FLAGS)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError(errno.EINVAL, "not a regular file", path)
        with os.fdopen(descriptor, "rb", buffering=0, closefd=False) as fh:
            while True:
                block = fh.read(4 * 1024 * 1024)
                if not block:
                    break
                h.update(block)
    finally:
        os.close(descriptor)
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


@dataclass
class _PathLockEntry:
    active: bool = False
    users: int = 0


class PathLocks:
    """Serialises work on one path so the watcher and a running scan never interleave
    chunk writes for the same file. Entries live only while a holder or waiter uses them."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._locks: dict[str, _PathLockEntry] = {}
        self._changed = threading.Condition(self._lock)

    @contextmanager
    def get(self, key: str) -> Iterator[None]:
        with self.get_many((key,)):
            yield

    @contextmanager
    def get_many(self, keys: tuple[str, ...]) -> Iterator[None]:
        keys = tuple(sorted({key.strip("/") for key in keys}))
        with self._changed:
            for key in keys:
                self._locks.setdefault(key, _PathLockEntry()).users += 1
        acquired = False
        try:
            with self._changed:
                while any(
                    entry.active and (
                        key == active or not key or not active or key.startswith(active + "/") or active.startswith(key + "/")
                    )
                    for key in keys for active, entry in self._locks.items()
                ):
                    self._changed.wait()
                for key in keys:
                    self._locks[key].active = True
                acquired = True
            yield
        finally:
            with self._changed:
                for key in keys:
                    entry = self._locks[key]
                    if acquired:
                        entry.active = False
                    entry.users -= 1
                    if entry.users == 0:
                        del self._locks[key]
                self._changed.notify_all()


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
    embed_backoff: EmbedBackoff = field(default_factory=EmbedBackoff, repr=False)
    image_embed_backoff: EmbedBackoff = field(default_factory=EmbedBackoff, repr=False)
    image_embed_health_seconds: float = 30.0
    _image_embed_health: tuple[float, ImageEmbedHealth] | None = field(default=None, repr=False)
    local: threading.local = field(default_factory=threading.local)
    activity: RootActivity = field(default_factory=RootActivity)

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
            if not value.values.indexer_enabled:
                self.activity.stop_queued()
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

    def image_embed_status(self) -> ImageEmbedHealth | None:
        """The sidecar's health, probed at most every ``image_embed_health_seconds``.

        A sidecar embedding at full speed can miss the probe's short timeout, and
        treating that as an outage paused embedding and skipped files mid-scan. Once
        it has answered healthy, an unanswered probe keeps that answer and the
        embedding request decides: a real outage fails it with a transport error,
        which pauses embedding. A sidecar that answers with a problem is believed.
        """
        with self.feature_lock:
            cached = self._image_embed_health
        if cached is not None and time.monotonic() - cached[0] < self.image_embed_health_seconds:
            return cached[1]
        health = image_embed_health(self.cfg.image_embed_url)
        if health is None and cached is not None:
            health = cached[1]
        with self.feature_lock:
            self._image_embed_health = (
                (time.monotonic(), health) if health is not None and dimension_guard(health) is None else None
            )
        return health

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
                'SELECT size, mtime_ns, text_status, deleted_at, sha256, error '
                'FROM "idx"."files" WHERE root_id = %s AND path = %s',
                (ctx.root_id, rel_path),
            )
            row = cur.fetchone()
        manifest_row = (row[0], row[1], row[2], row[3]) if row else None
        manifest_status = str(
            row[5]
            if row and row[5] == "excluded:image_dir"
            else (manifest_row[2] if manifest_row is not None else "")
        )
        unchanged = unchanged_in_db(manifest_row, st)
        if unchanged:
            if manifest_status.startswith("excluded") and exclusion_still_applies(ctx, rel_path, st.st_size):
                return False
            if not should_retry_unchanged(
                manifest_status, ext_of(os.path.basename(rel_path)), ctx.feature_configuration().values
            ):
                return False
        was_new = manifest_row is None
        # Feature transitions may re-extract an otherwise unchanged file. The
        # existing digest is still valid under the same size+mtime contract that
        # skips normal scans; new, changed, and explicitly pending rows rehash.
        known_sha256 = str(row[4]) if unchanged and row is not None and row[4] is not None else None
        _process_file(ctx, abs_path, rel_path, st, known_sha256)
        emit_event(ctx, "created" if was_new else "changed", rel_path)
        return True


def exclusion_still_applies(ctx: RootContext, rel_path: str, size: int) -> bool:
    from .chunking import is_image, is_pdf, is_tika

    if is_text_excluded(ctx.name, rel_path, list(ctx.settings.text_exclude_globs)):
        return True
    ext = ext_of(os.path.basename(rel_path))
    if is_image(ext):
        return not is_ocr_image_dir(ctx.name, rel_path, list(ctx.settings.ocr_image_globs)) or size > ctx.cfg.image_max_bytes
    return (is_pdf(ext) or is_tika(ext)) and size > ctx.cfg.text_max_bytes


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


def _note_embed_outage(ctx: RootContext, error: BaseException) -> None:
    if ctx.embed_backoff.note_failure():
        log(
            f"[{ctx.name}] embed backend unreachable ({type(error).__name__}: {error}); pausing embeddings. "
            "Affected files stay text-searchable and their vectors are backfilled on a later scan."
        )


def _note_embed_recovery(ctx: RootContext) -> None:
    if ctx.embed_backoff.note_success():
        log(f"[{ctx.name}] embed backend reachable again; resuming embeddings")


def _process_file(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result, known_sha256: str | None = None,
                  only_feature: str | None = None) -> None:
    conn = ctx.conn()
    name = os.path.basename(rel_path)
    ext = ext_of(name)
    mime = mimetypes.guess_type(name)[0]
    sha = known_sha256 or sha256_of(abs_path)
    file_id = db.upsert_file(conn, ctx.root_id, rel_path, name, ext, st.st_size, st.st_mtime_ns, sha, mime)

    from .chunking import is_image, is_textual

    features = ctx.feature_configuration().values
    if only_feature == "textSearch":
        features = replace(features, semantic_search=False, thumbnails=False, image_search=False)
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
    semantic_error = None
    semantic_waiting = False
    if text and status == "indexed":
        chars = len(text)
        limit = max_chunks_for(ext, ctx.cfg.max_chunks_per_file)
        pieces = chunk(text, ctx.cfg.chunk_chars, ctx.cfg.chunk_overlap, limit)
        vecs: list[list[float] | None]
        if features.semantic_search and ctx.embed_backoff.paused():
            # The backend is known to be down; do not re-probe it per file.
            vecs = [None] * len(pieces)
            error = "embed:unavailable"
            status = "partial"
            semantic_waiting = True
        elif features.semantic_search:
            try:
                vecs = list(embed_passages(pieces, ctx.cfg.embed_url, ctx.cfg.embed_batch))
                _note_embed_recovery(ctx)
            except Exception as e:  # noqa: BLE001 - keep text searchable via FTS, retry embeddings next scan
                if is_backend_outage(e):
                    _note_embed_outage(ctx, e)
                    semantic_waiting = True
                else:
                    log(f"embed failed for {rel_path}: {e}")
                vecs = [None] * len(pieces)
                semantic_error = failures.describe(e)
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

    if features.text_search:
        failures.report(ctx, rel_path, "textSearch", log, error if status == "error" else None,
                        skipped=status in ("excluded", "none") or status.startswith("disabled:"))
    if features.semantic_search:
        failures.report(ctx, rel_path, "semanticSearch", log,
                        semantic_error if status == "partial" and error != "embed:unavailable" else None,
                        skipped=semantic_waiting or not text)

    if features.internal_thumbnails:
        process_thumbnails(ctx, abs_path, rel_path, ext, sha, st.st_size)
    if features.image_search and is_image_candidate(ext) and skip_reason(st.st_size, ctx.cfg.thumb_max_bytes) is None:
        process_image_embedding(ctx, rel_path, sha)


def process_thumbnails(ctx: RootContext, abs_path: str, rel_path: str, ext: str, sha: str, size: int,
                       force: bool = False) -> tuple[bool, bool]:
    reason = skip_reason(size, ctx.cfg.thumb_max_bytes)
    if kind_for_ext(ext) is None or reason is not None:
        if reason is not None:
            log(f"thumb: skip {rel_path}: {reason}")
        failures.report(ctx, rel_path, "thumbnails", log, skipped=True)
        return True, True
    errors: list[str] = []
    nothing_to_render: list[str] = []
    try:
        thumbs = generate_thumbnails(abs_path, ext, sha, size, ctx.cfg.thumbs_dir, ctx.cfg.thumb_max_bytes,
                                     force=force, log=log, on_error=errors.append, on_skip=nothing_to_render.append)
        if nothing_to_render:
            failures.report(ctx, rel_path, "thumbnails", log, skipped=True, resolves=True)
            return True, True
        for out_size, rel_thumb_path, width, height in thumbs:
            db.upsert_thumbnail(ctx.conn(), sha, out_size, rel_thumb_path, width, height)
        if {thumb[0] for thumb in thumbs} != set(SIZES) and not errors:
            errors.append(f"Incomplete thumbnail: {len(thumbs)}/{len(SIZES)} sizes available")
    except Exception as exc:  # noqa: BLE001 - keep unrelated processing available
        errors.append(failures.describe(exc))
        log(f"thumb: unexpected failure for {rel_path}: {errors[-1]}")
    failures.report(ctx, rel_path, "thumbnails", log, errors[0] if errors else None)
    return not errors, False


def process_image_embedding(ctx: RootContext, rel_path: str, sha: str) -> bool:
    stage = _image_embedding_stage.get()
    attempt = failures.current()
    if stage is not None and attempt is not None:
        attempt.deferred.add("imageSearch")
        stage.submit(rel_path, sha, already_failed=any(not ok for ok, _skipped in attempt.outcomes.values()))
        return True
    errors: list[str] = []
    try:
        ok = embed_thumbnail(ctx, sha, on_error=errors.append)
        waiting = not ok and (ctx.image_embed_backoff.paused() or not ctx.cfg.image_embed_url)
        if not ok and not errors and not waiting:
            errors.append("Thumbnail unavailable: generate a preview before retrying image search")
        failures.report(ctx, rel_path, "imageSearch", log, errors[0] if errors else None, skipped=waiting)
        return ok or waiting
    except Exception as exc:  # noqa: BLE001
        reason = failures.describe(exc)
        log(f"image embed: unexpected failure for {rel_path}: {reason}")
        failures.report(ctx, rel_path, "imageSearch", log, reason)
        return False


class ImageEmbeddingStage:
    """Embeds a scan's thumbnails on one thread of its own.

    The sidecar runs one inference at a time, and a CPU model is far slower than
    thumbnailing. Waiting for it inline leaves every scan worker idle, so thumbnails,
    hashing and text for the rest of the tree trickle at the model's pace. Deferred
    files advance image search when their embedding finishes; the scan closes the
    stage before it completes.
    """

    def __init__(self, ctx: RootContext, operation: Operation | None, on_failure: Callable[[bool, bool], None]) -> None:
        self._ctx = ctx
        self._operation = operation
        self._on_failure = on_failure
        self._queue: queue.Queue[tuple[str, str, bool, bool] | None] = queue.Queue(maxsize=SCAN_BACKLOG_LIMIT)
        self._abandoned = False
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"image-embed-{ctx.name}")
        self._thread.start()

    def submit(self, rel_path: str, sha: str, already_failed: bool) -> None:
        self._queue.put((rel_path, sha, already_failed, _media_only_job.get()))

    def close(self, abandon: bool = False) -> None:
        self._abandoned = abandon
        self._queue.put(None)
        self._thread.join()

    def __enter__(self) -> ImageEmbeddingStage:
        return self

    def __exit__(self, error: type[BaseException] | None, *_details: object) -> None:
        # After a failed scan, queued files are dropped; the next scan finds them missing.
        self.close(abandon=error is not None)

    def _run(self) -> None:
        while (item := self._queue.get()) is not None:
            rel_path, sha, already_failed, media_only = item
            ok, skipped = True, True
            try:
                if not self._abandoned and self._ctx.feature_configuration().values.image_search:
                    with failures.attempt({"imageSearch": self._operation.id} if self._operation else {}) as observation:
                        process_image_embedding(self._ctx, rel_path, sha)
                    ok, skipped = observation.outcomes.get("imageSearch", (True, True))
            except Exception as exc:  # noqa: BLE001 - a dead stage would block every worker waiting to submit
                log(f"image embed: unexpected failure for {rel_path}: {failures.describe(exc)}")
                ok, skipped = False, False
            if self._operation is not None:
                self._operation.advance(ok, skipped)
            if not ok:
                self._on_failure(already_failed, media_only)


_image_embedding_stage: ContextVar[ImageEmbeddingStage | None] = ContextVar("image_embedding_stage", default=None)
_media_only_job: ContextVar[bool] = ContextVar("media_only_job", default=False)


def embed_thumbnail(ctx: RootContext, sha256: str, on_error: Callable[[str], None] | None = None) -> bool:
    """Embeds a file's 256px thumbnail through the image-embed sidecar and
    upserts the vector under `sha256`, unless it already has a row for the
    currently configured model. A no-op when `IMAGE_EMBED_URL` is not
    configured, when the sidecar fails the dimension/status guard, or when
    the 256px thumbnail was never written (e.g. it was over the thumbnail
    size budget)."""
    embed_url = ctx.cfg.image_embed_url
    if not embed_url or ctx.image_embed_backoff.paused():
        return False
    health = ctx.image_embed_status()
    guard = dimension_guard(health)
    if guard is not None:
        if ctx.image_embed_backoff.note_failure():
            log(f"image embed: {guard}; pausing image embeddings")
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
        if on_error is not None:
            on_error(failures.describe(e))
        return False

    try:
        embeddings, model = embed_images([data], embed_url, ctx.cfg.image_embed_batch_size)
    except Exception as error:
        if is_backend_outage(error):
            if ctx.image_embed_backoff.note_failure():
                log(f"image embed: backend unreachable ({type(error).__name__}); pausing image embeddings")
            return False
        raise
    if ctx.image_embed_backoff.note_success():
        log("image embed: backend reachable again; resuming image embeddings")
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
    sha = db.file_content_key(ctx.conn(), ctx.root_id, rel_path)
    if sha is None:
        return False
    ok, skipped = process_thumbnails(ctx, abs_path, rel_path, ext, sha, st.st_size)
    if features.image_search and is_image_candidate(ext) and not skipped:
        ok = process_image_embedding(ctx, rel_path, sha) and ok
    return ok


def media_derivatives_missing(
    ctx: RootContext, rel_path: str, size_bytes: int, key: str | None, image_embedded: bool, include_existing: bool = False
) -> bool:
    """Whether a live file needs enabled, durable media output rebuilt.

    This predicate makes work survive an indexer restart and a failed first
    attempt: derivative files and image-embedding rows are the durable state,
    while ``_backfill_media`` merely accelerates a feature transition. During
    that transition, ``include_existing`` refreshes manifest rows for eligible
    thumbnail files already on disk. ``key`` and ``image_embedded`` come from the
    scan's manifest snapshot; the job rechecks both before doing any work.
    """
    features = ctx.feature_configuration().values
    if not features.internal_thumbnails or key is None:
        return False
    ext = ext_of(os.path.basename(rel_path))
    if kind_for_ext(ext) is None:
        return False
    can_generate = within_size_budget(size_bytes, ctx.cfg.thumb_max_bytes)
    thumbnail_paths = [os.path.join(ctx.cfg.thumbs_dir, thumb_storage_path(key, size)) for size in SIZES]
    if can_generate and (include_existing or any(not os.path.exists(path) for path in thumbnail_paths)):
        return True
    return features.image_search and is_image_candidate(ext) and not image_embedded and os.path.exists(thumbnail_paths[0])


def embed_missing(ctx: RootContext, rel_path: str, *, expected_sha: str | None = None) -> bool:
    """Fill in embeddings for a file whose text is already chunked (status 'partial').

    Returns False when the embed backend is down, so the caller neither logs nor
    counts the file as an error: the row keeps its chunks and a later scan
    retries it. A backend that answers but rejects this payload still raises.
    """
    with ctx.path_locks.get(rel_path):
        ctx.maybe_refresh_features()
        if not ctx.feature_configuration().values.semantic_search:
            return True
        if ctx.embed_backoff.paused():
            return False
        conn = ctx.conn()
        if expected_sha is not None and db.file_content_key(conn, ctx.root_id, rel_path) != expected_sha:
            raise ValueError("Source changed or is no longer indexed. Reindex its text before retrying semantic search.")
        rows = db.chunks_missing_embeddings(conn, ctx.root_id, rel_path)
        if rows:
            try:
                vecs = embed_passages([t for _, t in rows], ctx.cfg.embed_url, ctx.cfg.embed_batch)
            except Exception as e:  # noqa: BLE001 - an absent backend is a service condition, not this file's error
                if not is_backend_outage(e):
                    failures.report(ctx, rel_path, "semanticSearch", log, failures.describe(e))
                    raise
                _note_embed_outage(ctx, e)
                return False
            _note_embed_recovery(ctx)
            db.set_chunk_embeddings(conn, [(cid, v) for (cid, _), v in zip(rows, vecs, strict=True)])
        db.mark_file_indexed(conn, ctx.root_id, rel_path)
        failures.report(ctx, rel_path, "semanticSearch", log)
        return True


def safe_process(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> str:
    """`process_file` on this thread's connection -> "indexed" | "unchanged" | "error".
    A failure is logged and recorded on the row."""
    try:
        return "indexed" if process_file(ctx, abs_path, rel_path, st) else "unchanged"
    except Exception as e:  # noqa: BLE001
        log(f"ERROR {rel_path}: {type(e).__name__}: {e}")
        for feature in work_features(ctx.feature_configuration().values, ext_of(rel_path)):
            failures.report(ctx, rel_path, feature, log, failures.describe(e))
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


def work_features(
    features: FeatureValues, ext: str | None = None, embed_only: bool = False, media_only: bool = False
) -> list[str]:
    from .chunking import is_textual

    result = []
    if features.text_search and not embed_only and not media_only:
        result.append("textSearch")
    if features.semantic_search and not media_only and (ext is None or is_textual(ext)):
        result.append("semanticSearch")
    if features.thumbnails and (not embed_only or media_only) and (ext is None or kind_for_ext(ext) is not None):
        result.append("thumbnails")
    if features.image_search and (not embed_only or media_only) and (ext is None or is_image_candidate(ext)):
        result.append("imageSearch")
    return result


def watch_index(ctx: RootContext, abs_path: str, rel_path: str, st: os.stat_result) -> str:
    ctx.maybe_refresh_features()
    if not ctx.feature_configuration().values.indexer_enabled:
        return "disabled"
    with failures.attempt() as observation:
        result = safe_process(ctx, abs_path, rel_path, st)
        return failures.FileResult(result, observation.outcomes)


def watch_mark_deleted(ctx: RootContext, rel_path: str, is_dir: bool) -> int:
    if not ctx.feature_configuration().values.indexer_enabled:
        return 0
    with ctx.path_locks.get(rel_path):
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
    with ctx.path_locks.get_many((old_rel, new_rel)):
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

        def queued(abs_path: str) -> Callable[[str], None]:
            configuration = ctx.feature_configuration()
            operations = ctx.activity.start_watch(work_features(configuration.values, ext_of(abs_path)), configuration.revision)
            return lambda result: ctx.activity.finish_watch(operations, result != "error", getattr(result, "outcomes", None))

        w = Watcher(
            ctx.abs_path,
            log,
            lambda a, r, s: watch_index(ctx, a, r, s),
            lambda r, d: watch_mark_deleted(ctx, r, d),
            lambda o, n, d: watch_rename(ctx, o, n, d),
            workers=workers,
            debounce=debounce,
            on_queue=queued,
        )
        w.start()
        log(f"[{ctx.name}] watching {w.dirs} directories for changes (debounce {debounce:g}s)")
        return w
    except Exception as e:  # noqa: BLE001
        log(f"[{ctx.name}] watcher unavailable ({type(e).__name__}: {e}); relying on periodic scans only")
        return None


def scan_once(ctx: RootContext) -> dict[str, int]:
    ctx.maybe_refresh_features()
    configuration = ctx.feature_configuration()
    operations = ctx.activity.start_scan(work_features(configuration.values), configuration.revision)
    outcome = "failed"
    try:
        result = _scan_once(ctx, operations)
        # Root/discovery errors have no file-stage outcome to carry the failure.
        outcome = "failed" if result["errors"] and not any(op.errors for op in operations.values()) else "completed"
        return result
    finally:
        enabled = ctx.feature_configuration().values.as_json()
        for feature, operation in operations.items():
            operation.finish(outcome if enabled[feature] else "stopped")


def _scan_once(ctx: RootContext, operations: dict[str, Operation]) -> dict[str, int]:
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
    manifest = db.scan_manifest(conn, ctx.root_id)

    seen: list[str] = []
    counters = {"changed": 0, "errors": 0}
    media_backfill_errors = 0
    n = 0
    t0 = time.time()
    workers = ctx.settings.workers
    lock = threading.Lock()

    def job(abs_path: str, rel_path: str, st: os.stat_result, embed_only: bool = False, media_only: bool = False) -> bool:
        nonlocal media_backfill_errors
        ctx.maybe_refresh_features()
        if not ctx.feature_configuration().values.indexer_enabled:
            return True
        media_ok = True
        if media_only:
            media_ok = backfill_media(ctx, abs_path, rel_path, st)
            if not media_ok:
                with lock:
                    media_backfill_errors += 1
            if not embed_only:
                return media_ok
        if embed_only:
            if not ctx.feature_configuration().values.semantic_search:
                return media_ok
            try:
                if not embed_missing(ctx, rel_path):
                    return media_ok
                ok = True
            except Exception as e:  # noqa: BLE001
                log(f"[{ctx.name}] embed retry failed for {rel_path}: {type(e).__name__}: {e}")
                ok = False
        else:
            result = safe_process(ctx, abs_path, rel_path, st)
            if result == "unchanged":
                return media_ok
            ok = result == "indexed"
        if ok:
            with lock:
                counters["changed"] += 1
        return ok and media_ok

    def image_failure(already_failed: bool, media_only: bool) -> None:
        nonlocal media_backfill_errors
        with lock:
            counters["errors"] += int(not already_failed)
            media_backfill_errors += int(media_only)

    image_operation = operations.get("imageSearch")
    stage = ImageEmbeddingStage(ctx, image_operation, image_failure) if image_operation and ctx.cfg.image_embed_url else None

    def tracked_job(
        abs_path: str, rel_path: str, st: os.stat_result, tracked: list[Operation], embed_only: bool, media_only: bool
    ) -> None:
        with failures.attempt({op.features[0]: op.id for op in tracked}) as observation:
            stage_token = _image_embedding_stage.set(stage if any(op is image_operation for op in tracked) else None)
            media_token = _media_only_job.set(media_only)
            job_ok = False
            try:
                job_ok = job(abs_path, rel_path, st, embed_only, media_only)
            except Exception as exc:
                for op in tracked:
                    feature = op.features[0]
                    if feature not in observation.outcomes and feature not in observation.deferred:
                        failures.report(ctx, rel_path, feature, log, failures.describe(exc))
                raise
            finally:
                _media_only_job.reset(media_token)
                _image_embedding_stage.reset(stage_token)
                if not job_ok or any(not ok for ok, _skipped in observation.outcomes.values()):
                    with lock:
                        counters["errors"] += 1
                for operation in tracked:
                    if operation.features[0] not in observation.deferred:
                        ok, skipped = observation.outcomes.get(operation.features[0], (True, True))
                        operation.advance(ok, skipped)

    # Traversal runs ahead of the workers so every feature's total is known long before
    # the work is done. Classified files wait in a backlog (a queued future costs three
    # times as much); only a bounded number are handed to the pool at once.
    backlog: deque[tuple[str, str, os.stat_result, list[Operation], bool, bool]] = deque()
    in_flight: set[Future[None]] = set()

    def submit(abs_path: str, rel_path: str, st: os.stat_result, embed_only: bool = False, media_only: bool = False) -> None:
        features = work_features(ctx.feature_configuration().values, ext_of(rel_path), embed_only, media_only)
        if embed_only and media_only and ctx.feature_configuration().values.semantic_search:
            features.append("semanticSearch")
        tracked = [operations[feature] for feature in features if feature in operations]
        for operation in tracked:
            operation.enqueue()
        backlog.append((abs_path, rel_path, st, tracked, embed_only, media_only))

    def dispatch(pool: ThreadPoolExecutor, block: bool) -> None:
        # Wait for any job, not the oldest: one slow video or OCR page must not leave
        # the other workers idle behind it.
        if block and in_flight:
            done = wait(in_flight, return_when=FIRST_COMPLETED).done
        else:
            done = {future for future in in_flight if future.done()}
        in_flight.difference_update(done)
        for future in done:
            future.result()
        while backlog and len(in_flight) < workers * 8:
            in_flight.add(pool.submit(tracked_job, *backlog.popleft()))

    traversal_complete = True

    def traversal_error() -> None:
        nonlocal traversal_complete
        traversal_complete = False

    # The stage closes after the pool: jobs still running may hand it embeddings.
    with stage or nullcontext(), ThreadPoolExecutor(max_workers=workers) as pool:
        for abs_path, rel_path, st in walk(ctx.abs_path, ctx.cfg.skip_names, ctx.cfg.skip_dirs, traversal_error):
            dispatch(pool, block=len(backlog) >= SCAN_BACKLOG_LIMIT)
            n += 1
            seen.append(rel_path)
            prev = manifest.get(rel_path)
            unchanged = prev is not None and prev[0] == st.st_size and prev[1] == st.st_mtime_ns and prev[3] is None
            ctx.maybe_refresh_features()
            if not ctx.feature_configuration().values.indexer_enabled:
                traversal_complete = False
                backlog.clear()
                break
            features = ctx.feature_configuration().values
            media_needed = (
                unchanged
                and prev is not None
                and media_derivatives_missing(
                    ctx, rel_path, st.st_size, prev[4], prev[5], include_existing=ctx.needs_media_backfill()
                )
            )
            retry_unchanged = prev is not None and should_retry_unchanged(prev[2], ext_of(os.path.basename(rel_path)), features)
            if prev is not None and prev[2].startswith("excluded") and exclusion_still_applies(ctx, rel_path, st.st_size):
                retry_unchanged = False
            if unchanged and prev is not None and prev[2] == "partial" and features.semantic_search:
                submit(abs_path, rel_path, st, True, media_needed)
            elif unchanged and retry_unchanged:
                submit(abs_path, rel_path, st)
            elif media_needed:
                submit(abs_path, rel_path, st, False, True)
            elif unchanged and prev is not None and prev[2] != "pending":
                # Includes disabled:* rows: retry_unchanged already found nothing to do,
                # and a job would only repeat that check for every image on every scan.
                continue
            else:
                submit(abs_path, rel_path, st)
        if traversal_complete:
            for operation in operations.values():
                operation.discovered()
        while backlog or in_flight:
            dispatch(pool, block=True)

    # A worker can observe disablement after traversal has already finished.
    traversal_complete = traversal_complete and ctx.feature_configuration().values.indexer_enabled
    deleted = db.sweep_vanished(conn, ctx.root_id, seen, started) if traversal_complete else 0
    if traversal_complete and ctx.needs_media_backfill() and not media_backfill_errors:
        ctx.finish_media_backfill()
    db.finish_scan(conn, scan_id, n, counters["changed"], deleted, counters["errors"])
    db.prune_events(conn, ctx.cfg.events_retention_days)
    failures.prune(conn)
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
