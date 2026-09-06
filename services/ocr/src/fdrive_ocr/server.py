"""Internal HTTP API, bound to the compose network only, no auth: health, stats,
and a manual run trigger. Built on Starlette, matching the indexer's
`server.py`. A `RunLock` shared with the nightly scheduler loop (`main.py`)
prevents a manual `/run` from racing the scheduled pass.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import psycopg
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import db
from .runner import RootTarget, originals_stats, run_pass
from .schedule import next_run_at
from .settings import Settings, resolve_settings
from .stats import shape_health, shape_stats


class RunLock:
    """Guards against two OCR passes running at once."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running = False

    def try_acquire(self) -> bool:
        with self._lock:
            if self._running:
                return False
            self._running = True
            return True

    def release(self) -> None:
        with self._lock:
            self._running = False

    @property
    def running(self) -> bool:
        with self._lock:
            return self._running


@dataclass
class ServerState:
    conn_factory: Callable[[], psycopg.Connection]
    targets: list[RootTarget]
    state_dir: str
    default_settings: Settings
    timeout_seconds: int
    jobs: int
    run_lock: RunLock
    now: Callable[[], datetime]
    schema_ready: Callable[[], bool]
    log: Callable[[str], None]


async def health(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    return JSONResponse(shape_health(state.schema_ready(), state.run_lock.running))


async def stats(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    conn = state.conn_factory()
    try:
        raw = db.read_settings(conn)
        settings = resolve_settings(raw, state.default_settings)
        last = db.last_run(conn)
    finally:
        conn.close()
    originals_count, originals_bytes = originals_stats(state.state_dir)
    next_at = next_run_at(state.now(), settings.hour)
    body = shape_stats(
        last,
        next_at.isoformat(),
        settings.hour,
        settings.langs,
        list(settings.exclude_globs),
        settings.max_mb,
        settings.keep_originals,
        originals_count,
        originals_bytes,
        state.run_lock.running,
    )
    return JSONResponse(body)


async def trigger_run(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    if not state.run_lock.try_acquire():
        return JSONResponse({"error": "already running"}, status_code=409)

    def worker() -> None:
        conn = state.conn_factory()
        try:
            raw = db.read_settings(conn)
            settings = resolve_settings(raw, state.default_settings)
            run_pass(conn, state.targets, settings, state.state_dir, state.timeout_seconds, state.jobs, state.log)
        except Exception as e:  # noqa: BLE001
            state.log(f"OCR pass crashed: {type(e).__name__}: {e}")
        finally:
            conn.close()
            state.run_lock.release()

    threading.Thread(target=worker, daemon=True, name="ocr-run").start()
    return JSONResponse({"started": True}, status_code=202)


def create_app(state: ServerState) -> Starlette:
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/stats", stats, methods=["GET"]),
            Route("/run", trigger_run, methods=["POST"]),
        ]
    )
    app.state.server_state = state
    return app
