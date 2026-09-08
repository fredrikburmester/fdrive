"""Internal HTTP API, bound to the compose network only, no auth: health, stats,
and a manual run trigger. Built on Starlette, matching the indexer's
`server.py`. A `RunLock` shared with the nightly scheduler loop (`main.py`)
prevents a manual `/run` from racing the scheduled pass.
"""

from __future__ import annotations

import os
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
from .features import FeatureConfiguration, FeatureValues, resolve_features
from .runner import RootTarget, originals_stats, run_pass
from .schedule import next_run_at
from .settings import Settings, resolve_settings
from .stats import shape_health, shape_stats

LEGACY_FEATURES = FeatureValues(True, True, False, True, False, True)


def storage_diagnostics(targets: list[RootTarget]) -> dict[str, dict[str, bool]]:
    """Bounded, non-mutating mount probe. OCR needs a writable mounted root."""
    result: dict[str, dict[str, bool]] = {}
    for target in targets:
        readable = False
        try:
            with os.scandir(target.abs_path) as entries:
                next(entries, None)
            readable = os.access(target.abs_path, os.R_OK)
        except OSError:
            pass
        result[target.name] = {"readable": readable, "writable": os.access(target.abs_path, os.W_OK)}
    return result


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
    # Env-only (OCR_INCLUDE_GLOBS), not part of app.settings; see rules.is_excluded.
    include_globs: tuple[str, ...] = ()
    feature_defaults: FeatureConfiguration | None = None
    features_managed: bool = False

    def features(self, raw: dict[str, object]) -> FeatureConfiguration:
        if self.feature_defaults is None:
            # Existing direct callers preserve historical OCR admission.
            return FeatureConfiguration(0, LEGACY_FEATURES)
        return resolve_features(raw, self.feature_defaults.values, self.features_managed)


async def health(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    conn = state.conn_factory()
    try:
        features = state.features(db.read_settings(conn))
    finally:
        conn.close()
    body = shape_health(
        state.schema_ready(),
        state.run_lock.running,
        {"revision": features.revision, "values": features.values.as_json()},
    )
    body["storage"] = storage_diagnostics(state.targets)
    return JSONResponse(body)


async def stats(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    conn = state.conn_factory()
    try:
        raw = db.read_settings(conn)
        settings = resolve_settings(raw, state.default_settings)
        features = state.features(raw)
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
        {"revision": features.revision, "values": features.values.as_json()},
    )
    return JSONResponse(body)


async def trigger_run(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    conn = state.conn_factory()
    try:
        if not state.features(db.read_settings(conn)).values.pdf_ocr:
            return JSONResponse({"error": "PDF OCR disabled"}, status_code=409)
    finally:
        conn.close()
    if not state.run_lock.try_acquire():
        return JSONResponse({"error": "already running"}, status_code=409)

    def worker() -> None:
        conn = state.conn_factory()
        try:
            raw = db.read_settings(conn)
            if not state.features(raw).values.pdf_ocr:
                state.log("OCR run stopped: PDF OCR disabled")
                return
            settings = resolve_settings(raw, state.default_settings)
            run_pass(
                conn,
                state.targets,
                settings,
                state.state_dir,
                state.timeout_seconds,
                state.jobs,
                state.log,
                state.include_globs,
                is_enabled=lambda: state.features(db.read_settings(conn)).values.pdf_ocr,
            )
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
