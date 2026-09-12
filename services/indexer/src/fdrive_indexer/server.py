"""Internal HTTP API, bound to the compose network only, no auth: health, stats, live
extraction, and reindex triggers. Built on Starlette so it can run under uvicorn
without pulling in a full web framework.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from uuid import uuid4

import psycopg
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import db
from .activity import timestamp
from .chunking import is_textual
from .clear_jobs import clear_image_embeddings, clear_index, clear_thumbnails, start_clear
from .directory_listing import directory_parts, directory_query, list_directory
from .extract import embed_health
from .features import FeatureConfiguration
from .image_embed_rebuild import start_image_embed_rebuild
from .indexer import RootContext, work_features
from .paths import ext_of, reindex_scope
from .stats import shape_health, shape_stats
from .thumb_rebuild import ThumbnailRebuildJob, start_rebuild


@dataclass
class ServerState:
    contexts: dict[str, RootContext]
    watchers: dict[str, object | None]
    wake_events: dict[str, threading.Event]
    conn_factory: Callable[[], psycopg.Connection]
    schema_version: Callable[[], int | None]
    feature_configuration: Callable[[], FeatureConfiguration] | None = None
    thumbnail_job: ThumbnailRebuildJob = field(default_factory=ThumbnailRebuildJob)
    index_clear_job: ThumbnailRebuildJob = field(default_factory=ThumbnailRebuildJob)
    thumbnail_clear_job: ThumbnailRebuildJob = field(default_factory=ThumbnailRebuildJob)
    image_embed_rebuild_job: ThumbnailRebuildJob = field(default_factory=ThumbnailRebuildJob)
    image_embed_clear_job: ThumbnailRebuildJob = field(default_factory=ThumbnailRebuildJob)

    instance_id: str = field(default_factory=lambda: str(uuid4()))

    def __post_init__(self) -> None:
        self.index_clear_job.admission = self.thumbnail_job.admission
        self.thumbnail_clear_job.admission = self.thumbnail_job.admission
        self.image_embed_rebuild_job.admission = self.thumbnail_job.admission
        self.image_embed_clear_job.admission = self.thumbnail_job.admission


_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def _extract_parts(path: str) -> list[str]:
    """Validate the request path and return root-relative path components."""
    if not path:
        raise ValueError("invalid path")
    return directory_parts(path if path.startswith("/") else f"/{path}")


def _descriptor_path(descriptor: int) -> str:
    """Return a pathname that reopens an already validated descriptor."""
    for directory in ("/proc/self/fd", "/dev/fd"):
        if os.path.isdir(directory):
            return f"{directory}/{descriptor}"
    raise OSError(errno.ENOSYS, "descriptor paths are unavailable")


@contextmanager
def _open_extraction_file(root: str, path: str) -> Iterator[tuple[str, int]]:
    """Open a regular file beneath `root` without following descendant symlinks.

    The descriptor-backed path keeps extractors bound to the opened inode if an
    entry is renamed while extraction is in progress.
    """
    parts = _extract_parts(path)
    if not parts:
        raise ValueError("invalid path")
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file_descriptor = os.open(parts[-1], _FILE_FLAGS, dir_fd=descriptor)
        try:
            metadata = os.fstat(file_descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise OSError(errno.ENOENT, "not a regular file")
            yield _descriptor_path(file_descriptor), metadata.st_size
        finally:
            os.close(file_descriptor)
    finally:
        os.close(descriptor)


def storage_diagnostics(contexts: dict[str, RootContext]) -> dict[str, dict[str, bool]]:
    """Bounded, non-mutating mount probe for setup and worker readiness."""
    result: dict[str, dict[str, bool]] = {}
    for name, ctx in contexts.items():
        readable = False
        try:
            with os.scandir(ctx.abs_path) as entries:
                next(entries, None)
            readable = os.access(ctx.abs_path, os.R_OK)
        except OSError:
            pass
        result[name] = {"readable": readable, "writable": os.access(ctx.abs_path, os.W_OK)}
    return result


async def directory(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    try:
        root, path = directory_query(request.query_params.multi_items())
    except ValueError:
        return JSONResponse({"error": "invalid directory query"}, status_code=400)
    ctx = state.contexts.get(root)
    if ctx is None:
        return JSONResponse({"error": "unknown root"}, status_code=404)
    try:
        result = await run_in_threadpool(list_directory, ctx.abs_path, path)
    except OSError as error:
        statuses: dict[int | None, int] = {
            errno.ENOENT: 404,
            errno.ENOTDIR: 400,
            errno.ELOOP: 400,
            errno.EACCES: 403,
            errno.EPERM: 403,
        }
        status = statuses.get(error.errno, 503)
        return JSONResponse({"error": "directory unavailable"}, status_code=status)
    return JSONResponse(result)


async def health(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    roots = list(state.contexts)
    watcher_status = {name: state.watchers.get(name) is not None for name in roots}
    features = state.feature_configuration() if state.feature_configuration else None
    embed_url = next(iter(state.contexts.values())).cfg.embed_url if state.contexts else ""
    # An unavailable optional embedding service must not delay setup health.
    embed_ok = bool(features and features.values.semantic_search and embed_url and embed_health(embed_url, timeout=1))
    body = shape_health(
        roots,
        watcher_status,
        embed_ok,
        state.schema_version(),
        {"revision": features.revision, "values": features.values.as_json()} if features else None,
    )
    body["storage"] = storage_diagnostics(state.contexts)
    return JSONResponse(body)



async def activity(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    operations = []
    for ctx in state.contexts.values():
        for operation in ctx.activity.snapshot():
            if (
                "semanticSearch" in operation["features"]
                and ctx.embed_backoff.waiting()
                and ctx.feature_configuration().values.semantic_search
            ):
                operation = {**operation, "state": "waiting", "phase": "waiting", "total": None, "finishedAt": None}
            operations.append(operation)
    for job, kind, features in [
        (state.thumbnail_job, "thumbnailRebuild", ["thumbnails"]),
        (state.thumbnail_clear_job, "thumbnailClear", ["thumbnails"]),
        (state.index_clear_job, "indexClear", ["textSearch", "semanticSearch"]),
        (state.image_embed_rebuild_job, "imageRebuild", ["imageSearch"]),
        (state.image_embed_clear_job, "imageClear", ["imageSearch"]),
    ]:
        snapshot = job.activity_snapshot(kind, features)
        if snapshot is not None:
            operations.append(snapshot)
    return JSONResponse({"instanceId": state.instance_id, "observedAt": timestamp(), "operations": operations})

async def stats(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    conn = state.conn_factory()
    per_root = []
    errors: list[dict[str, object]] = []
    queue_depth = 0
    for name, ctx in state.contexts.items():
        per_root.append(db.root_stats(conn, name, ctx.root_id))
        errors.extend(db.errors_sample(conn, ctx.root_id))
        manifest = db.get_manifest(conn, ctx.root_id)
        queue_depth += sum(1 for row in manifest.values() if row[2] == "pending")
    features = state.feature_configuration() if state.feature_configuration else None
    body = shape_stats(
        per_root,
        db.thumbnails_count(conn),
        queue_depth,
        errors,
        state.thumbnail_job.snapshot(),
        db.image_embeddings_count(conn),
        state.image_embed_rebuild_job.snapshot(),
        {"revision": features.revision, "values": features.values.as_json()} if features else None,
    )
    body["index_clear"] = state.index_clear_job.snapshot()
    body["thumbnail_clear"] = state.thumbnail_clear_job.snapshot()
    body["image_embedding_clear"] = state.image_embed_clear_job.snapshot()
    return JSONResponse(body)


async def extract_text(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    payload = await request.json()
    root_name = payload.get("root")
    path = payload.get("path")
    if not isinstance(root_name, str) or not isinstance(path, str):
        return JSONResponse({"error": "root and path are required"}, status_code=400)
    ctx = state.contexts.get(root_name)
    if ctx is None:
        return JSONResponse({"error": f"unknown root: {root_name}"}, status_code=404)
    features = ctx.feature_configuration().values
    if not features.text_search:
        return JSONResponse({"text": None, "status": "disabled"})
    ext = ext_of(os.path.basename(path))
    from .chunking import is_image

    try:
        with _open_extraction_file(ctx.abs_path, path) as (opened_path, size):
            if is_image(ext) and not features.search_ocr:
                return JSONResponse({"text": None, "status": "disabled"})
            if not is_textual(ext):
                return JSONResponse({"text": None, "status": "none"})
            text, status = ctx.extractor.extract(
                opened_path, path, ext, size, search_ocr=ctx.feature_configuration().values.search_ocr
            )
    except ValueError:
        return JSONResponse({"error": "invalid path"}, status_code=400)
    except OSError as error:
        statuses: dict[int | None, int] = {
            errno.ENOENT: 404,
            errno.ENOTDIR: 400,
            errno.ELOOP: 400,
            errno.EACCES: 403,
            errno.EPERM: 403,
        }
        status_code = statuses.get(error.errno, 503)
        message = "not found" if status_code == 404 else "path unavailable"
        return JSONResponse({"error": message}, status_code=status_code)
    if text is None:
        return JSONResponse({"text": None, "status": status})
    offset = int(payload.get("offset") or 0)
    max_chars = payload.get("max_chars")
    sliced = text[offset:] if max_chars is None else text[offset : offset + int(max_chars)]
    return JSONResponse({"text": sliced, "status": status, "total_chars": len(text)})


async def reindex(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    payload = await request.json()
    root_name = payload.get("root")
    path = payload.get("path")
    if not isinstance(root_name, str):
        return JSONResponse({"error": "root is required"}, status_code=400)
    ctx = state.contexts.get(root_name)
    if ctx is None:
        return JSONResponse({"error": f"unknown root: {root_name}"}, status_code=404)
    features = ctx.feature_configuration().values
    if not features.indexer_enabled:
        return JSONResponse({"error": "feature processing disabled"}, status_code=409)
    scoped_path = path if isinstance(path, str) else None
    exact, prefix = reindex_scope(scoped_path)
    count = db.mark_pending(ctx.conn(), ctx.root_id, exact, prefix)
    ctx.activity.queue_scan(work_features(features), ctx.feature_configuration().revision)
    event = state.wake_events.get(root_name)
    if event is not None:
        event.set()
    if payload.get("thumbnails") is True and features.internal_thumbnails:
        # Best effort: if a rebuild is already running this just does not queue a
        # second one. The next reindex or manual rebuild will still cover it.
        start_rebuild(state.thumbnail_job, [ctx], scoped_path, force=False)
    return JSONResponse({"count": count})


async def thumbnails_rebuild(request: Request) -> JSONResponse:
    """Regenerates thumbnails only: `app.thumbnails` rows are rewritten, but
    `text_status`, chunks, and embeddings are never touched, unlike `/reindex`.
    Runs in a background thread; `GET /stats` reports its progress under
    `thumbnail_rebuild` while it runs."""
    state: ServerState = request.app.state.server_state
    payload = await request.json() if await request.body() else {}
    root_name = payload.get("root")
    path = payload.get("path")
    force = payload.get("force") is True
    if root_name is not None and not isinstance(root_name, str):
        return JSONResponse({"error": "root must be a string"}, status_code=400)
    if path is not None and not isinstance(path, str):
        return JSONResponse({"error": "path must be a string"}, status_code=400)
    names = [root_name] if isinstance(root_name, str) else list(state.contexts)
    contexts = [state.contexts[name] for name in names if name in state.contexts]
    if contexts and not any(ctx.feature_configuration().values.internal_thumbnails for ctx in contexts):
        return JSONResponse({"error": "thumbnail processing disabled"}, status_code=409)
    total = start_rebuild(state.thumbnail_job, contexts, path, force)
    if total is None:
        return JSONResponse({"error": "a thumbnail rebuild is already running"}, status_code=409)
    return JSONResponse({"started": True, "total": total}, status_code=202)


_CLEAR_ROUTES = {
    "/index/clear": "index",
    "/thumbnails/clear": "thumbnails",
    "/image-embeddings/clear": "image_embeddings",
}


async def clear(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    try:
        payload = await request.json() if await request.body() else {}
    except (ValueError, json.JSONDecodeError):
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    kind = _CLEAR_ROUTES[request.url.path]
    allowed = {"root", "path"} if kind == "index" else set()
    if set(payload) - allowed:
        return JSONResponse({"error": "unknown fields"}, status_code=400)
    for field_name in allowed:
        if field_name in payload and (not isinstance(payload[field_name], str) or not payload[field_name].strip()):
            return JSONResponse({"error": f"{field_name} must be a nonempty string"}, status_code=400)
    root_name = payload.get("root")
    path = payload.get("path")
    if path is not None and root_name is None:
        return JSONResponse({"error": "path requires root"}, status_code=400)
    if path is not None and (".." in path.split("/") or "\\" in path or "\x00" in path):
        return JSONResponse({"error": "invalid path"}, status_code=400)
    if root_name is not None and root_name not in state.contexts:
        return JSONResponse({"error": f"unknown root: {root_name}"}, status_code=404)
    contexts = [state.contexts[root_name]] if root_name is not None else list(state.contexts.values())
    scope = os.path.normpath(path.lstrip("/")) if path is not None else None
    if scope == ".":
        scope = None
    job = {
        "index": state.index_clear_job,
        "thumbnails": state.thumbnail_clear_job,
        "image_embeddings": state.image_embed_clear_job,
    }[kind]

    def operation() -> None:
        if kind == "thumbnails":
            clear_thumbnails(contexts, job)
        elif kind == "image_embeddings":
            clear_image_embeddings(contexts, job)
        else:
            clear_index(contexts, scope, job)

    try:
        started = start_clear(job, operation)
    except Exception:
        return JSONResponse({"error": "could not start clear job"}, status_code=500)
    if not started:
        return JSONResponse({"error": "a clear or thumbnail rebuild is already running"}, status_code=409)
    return JSONResponse({"started": True}, status_code=202)


async def image_embeddings_rebuild(request: Request) -> JSONResponse:
    """Backfills (or, with `force`, replaces stale-model rows for) image
    embeddings. Runs in a background thread sharing the thumbnail-rebuild
    admission lock; `GET /stats` reports its progress under
    `image_embedding_rebuild` while it runs. Mirrors `/thumbnails/rebuild`'s
    request shape and validation."""
    state: ServerState = request.app.state.server_state
    payload = await request.json() if await request.body() else {}
    root_name = payload.get("root")
    path = payload.get("path")
    force = payload.get("force") is True
    if root_name is not None and not isinstance(root_name, str):
        return JSONResponse({"error": "root must be a string"}, status_code=400)
    if path is not None and not isinstance(path, str):
        return JSONResponse({"error": "path must be a string"}, status_code=400)
    names = [root_name] if isinstance(root_name, str) else list(state.contexts)
    contexts = [state.contexts[name] for name in names if name in state.contexts]
    if contexts and not any(ctx.feature_configuration().values.image_search for ctx in contexts):
        return JSONResponse({"error": "image search disabled"}, status_code=409)
    total = start_image_embed_rebuild(state.image_embed_rebuild_job, contexts, path, force)
    if total is None:
        return JSONResponse({"error": "an image-embedding rebuild is already running"}, status_code=409)
    return JSONResponse({"started": True, "total": total}, status_code=202)


def create_app(state: ServerState) -> Starlette:
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/directory", directory, methods=["GET"]),
            Route("/stats", stats, methods=["GET"]),
            Route("/activity", activity, methods=["GET"]),
            Route("/extract", extract_text, methods=["POST"]),
            Route("/reindex", reindex, methods=["POST"]),
            Route("/index/clear", clear, methods=["POST"]),
            Route("/thumbnails/clear", clear, methods=["POST"]),
            Route("/thumbnails/rebuild", thumbnails_rebuild, methods=["POST"]),
            Route("/image-embeddings/clear", clear, methods=["POST"]),
            Route("/image-embeddings/rebuild", image_embeddings_rebuild, methods=["POST"]),
        ]
    )
    app.state.server_state = state
    return app
