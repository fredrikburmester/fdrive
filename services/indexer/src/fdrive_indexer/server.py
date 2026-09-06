"""Internal HTTP API, bound to the compose network only, no auth: health, stats, live
extraction, and reindex triggers. Built on Starlette so it can run under uvicorn
without pulling in a full web framework.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass

import psycopg
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import db
from .chunking import is_textual
from .extract import embed_health
from .indexer import RootContext
from .paths import ext_of, reindex_scope
from .stats import shape_health, shape_stats


@dataclass
class ServerState:
    contexts: dict[str, RootContext]
    watchers: dict[str, object | None]
    wake_events: dict[str, threading.Event]
    conn_factory: Callable[[], psycopg.Connection]
    schema_version: Callable[[], int | None]


def _safe_abs_path(ctx: RootContext, rel_path: str) -> str | None:
    """Resolve `rel_path` under the root, refusing anything that escapes it."""
    candidate = os.path.normpath(os.path.join(ctx.abs_path, rel_path.lstrip("/")))
    root = os.path.normpath(ctx.abs_path)
    if candidate != root and not candidate.startswith(root + os.sep):
        return None
    return candidate


async def health(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    roots = list(state.contexts)
    watcher_status = {name: state.watchers.get(name) is not None for name in roots}
    embed_url = next(iter(state.contexts.values())).cfg.embed_url if state.contexts else ""
    embed_ok = embed_health(embed_url) if embed_url else False
    body = shape_health(roots, watcher_status, embed_ok, state.schema_version())
    return JSONResponse(body)


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
    body = shape_stats(per_root, db.thumbnails_count(conn), queue_depth, errors)
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
    abs_path = _safe_abs_path(ctx, path)
    if abs_path is None:
        return JSONResponse({"error": "path escapes root"}, status_code=400)
    if not os.path.isfile(abs_path):
        return JSONResponse({"error": "not found"}, status_code=404)
    ext = ext_of(os.path.basename(path))
    if not is_textual(ext):
        return JSONResponse({"text": None, "status": "none"})
    size = os.path.getsize(abs_path)
    text, status = ctx.extractor.extract(abs_path, path, ext, size)
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
    exact, prefix = reindex_scope(path if isinstance(path, str) else None)
    count = db.mark_pending(ctx.conn(), ctx.root_id, exact, prefix)
    event = state.wake_events.get(root_name)
    if event is not None:
        event.set()
    return JSONResponse({"count": count})


async def thumbnails_rebuild(request: Request) -> JSONResponse:
    """Best-effort: marks the scoped rows pending, which makes the next scan
    regenerate any thumbnail that is missing on disk (existing ones are left; there
    is no forced-regenerate switch in v1)."""
    state: ServerState = request.app.state.server_state
    payload = await request.json() if await request.body() else {}
    root_name = payload.get("root")
    total = 0
    targets = [root_name] if root_name else list(state.contexts)
    for name in targets:
        ctx = state.contexts.get(name)
        if ctx is None:
            continue
        total += db.mark_pending(ctx.conn(), ctx.root_id, None, None)
        event = state.wake_events.get(name)
        if event is not None:
            event.set()
    return JSONResponse({"count": total})


def create_app(state: ServerState) -> Starlette:
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/stats", stats, methods=["GET"]),
            Route("/extract", extract_text, methods=["POST"]),
            Route("/reindex", reindex, methods=["POST"]),
            Route("/thumbnails/rebuild", thumbnails_rebuild, methods=["POST"]),
        ]
    )
    app.state.server_state = state
    return app
