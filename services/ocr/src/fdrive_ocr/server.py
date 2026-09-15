"""Internal HTTP API, bound to the compose network only, no auth: health, stats,
a manual run trigger, and administration of the originals kept before each
rewrite. Built on Starlette, matching the indexer's `server.py`. A `RunLock`
shared with the nightly scheduler loop (`main.py`) prevents a manual `/run`
from racing the scheduled pass.

Only `/run` is gated on the `pdfOcr` feature. Listing, downloading, restoring
and deleting kept originals stay available while OCR is switched off, because
switching it off is exactly what an operator does first when a pass has
damaged a file they now need back.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import psycopg
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from . import db
from .features import FeatureConfiguration, resolve_features
from .restore import (
    OriginalsIndex,
    RestoreOutcome,
    delete_original,
    list_originals,
    open_original,
    prune_originals,
    restore_original,
)
from .runner import RootTarget, run_pass
from .schedule import next_run_at
from .settings import Settings, resolve_settings
from .stats import shape_health, shape_stats


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
        self.instance_id = str(uuid4())
        self._operation: dict[str, Any] | None = None

    def try_acquire(self) -> bool:
        with self._lock:
            if self._running:
                return False
            self._running = True
            self._operation = {
                "id": str(uuid4()), "kind": "ocr", "features": ["pdfOcr"], "revision": 0,
                "state": "running", "phase": "queued", "processed": 0, "total": None,
                "errors": 0, "skipped": 0, "unit": "files",
                "startedAt": datetime.now(UTC).isoformat(), "finishedAt": None,
            }
            return True

    def release(self) -> None:
        with self._lock:
            self._running = False
            if self._operation is not None:
                if self._operation["state"] == "running":
                    self._operation["state"] = "failed" if self._operation["errors"] else "completed"
                self._operation["finishedAt"] = datetime.now(UTC).isoformat()

    def begin(self, revision: int) -> None:
        with self._lock:
            if self._operation is not None:
                self._operation.update(revision=revision, phase="processing")

    def advance(self, status: str, rewrite: bool) -> None:
        with self._lock:
            if self._operation is not None:
                failed = status in ("failed", "timeout")
                self._operation["processed"] += 1
                self._operation["errors"] += int(failed)
                self._operation["skipped"] += int(not rewrite and not failed)

    def stop(self) -> None:
        with self._lock:
            if self._operation is not None:
                self._operation["state"] = "stopped"

    def fail(self) -> None:
        with self._lock:
            if self._operation is not None:
                self._operation["errors"] += 1
                self._operation["state"] = "failed"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "instanceId": self.instance_id, "observedAt": datetime.now(UTC).isoformat(),
                "operations": [dict(self._operation)] if self._operation is not None else [],
            }

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
    originals: OriginalsIndex = field(default_factory=OriginalsIndex)
    # Env-only (OCR_INCLUDE_GLOBS), not part of app.settings; see rules.is_excluded.
    include_globs: tuple[str, ...] = ()

    def features(self, raw: dict[str, object]) -> FeatureConfiguration:
        return resolve_features(raw)


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


async def activity(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    return JSONResponse(state.run_lock.snapshot())


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
    originals_count, originals_bytes = state.originals.stats(state.state_dir)
    next_at = next_run_at(state.now(), settings.hour)
    body = shape_stats(
        last,
        next_at.isoformat(),
        settings.hour,
        settings.langs,
        list(settings.exclude_globs),
        settings.max_mb,
        settings.keep_originals,
        settings.originals_retention_days,
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
        conn = None
        try:
            conn = state.conn_factory()
            raw = db.read_settings(conn)
            if not state.features(raw).values.pdf_ocr:
                state.run_lock.stop()
                state.log("OCR run stopped: PDF OCR disabled")
                return
            state.run_lock.begin(state.features(raw).revision)
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
                on_file=state.run_lock.advance, on_stopped=state.run_lock.stop,
            )
            prune_originals(conn, state.state_dir, state.originals, settings.originals_retention_days, state.log)
        except Exception as e:  # noqa: BLE001
            state.run_lock.fail()
            state.log(f"OCR pass crashed: {type(e).__name__}: {e}")
        finally:
            try:
                if conn is not None:
                    conn.close()
            finally:
                state.run_lock.release()

    try:
        threading.Thread(target=worker, daemon=True, name="ocr-run").start()
    except Exception as error:  # noqa: BLE001 - failed thread creation must release admission
        state.run_lock.fail()
        state.run_lock.release()
        state.log(f"OCR run could not start: {type(error).__name__}: {error}")
        return JSONResponse({"error": "could not start OCR run"}, status_code=500)
    return JSONResponse({"started": True}, status_code=202)


DEFAULT_PAGE_LIMIT = 50
MAX_PAGE_LIMIT = 200

#: Why a restore was refused, and the status the API layer should surface. A
#: refusal is never a server fault: the caller either asked for an original that
#: is not there, or declined to opt into a destructive case it can now see.
RESTORE_REFUSAL_STATUS = {
    "not_found": 404,
    "unresolved": 409,
    "unknown_root": 409,
    "invalid_path": 409,
    "target_parent_missing": 409,
    "target_missing": 409,
    "target_changed": 409,
    "corrupt": 409,
}


def _int_param(request: Request, name: str, default: int, minimum: int, maximum: int) -> int:
    raw = request.query_params.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (ValueError, TypeError):
        return {}
    return body if isinstance(body, dict) else {}


async def originals(request: Request) -> JSONResponse:
    """One page of kept originals. Deliberately not gated on the `pdfOcr`
    feature: an operator who turned OCR off because it damaged a file still
    needs to find and undo what it did."""
    state: ServerState = request.app.state.server_state
    limit = _int_param(request, "limit", DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT)
    offset = _int_param(request, "offset", 0, 0, 2**31 - 1)
    query = request.query_params.get("query", "")
    conn = state.conn_factory()
    try:
        items, total = list_originals(conn, state.state_dir, state.targets, state.originals, query, offset, limit)
    finally:
        conn.close()
    return JSONResponse(
        {"items": [item.as_json() for item in items], "total": total, "offset": offset, "limit": limit}
    )


async def download_original(request: Request) -> Response:
    """Streams a kept original's bytes so it can be compared against the live
    file before anything is overwritten, and so an original whose source path
    can no longer be resolved is still recoverable by hand."""
    state: ServerState = request.app.state.server_state
    original_id = request.query_params.get("id", "")
    found = open_original(state.state_dir, original_id)
    if found is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    path, _size = found
    return FileResponse(path, media_type="application/pdf", filename=original_id)


async def restore(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    body = await _json_body(request)
    original_id = body.get("id")
    if not isinstance(original_id, str):
        return JSONResponse({"error": "id is required"}, status_code=400)
    def perform_restore() -> RestoreOutcome:
        conn = state.conn_factory()
        try:
            return restore_original(
                conn, state.state_dir, state.targets, state.originals, original_id,
                body.get("allow_recreate") is True, body.get("allow_overwrite_changed") is True, state.log,
            )
        finally:
            conn.close()

    # Copying and waiting for advisory locks must not block health/activity.
    outcome = await run_in_threadpool(perform_restore)
    if not outcome.ok:
        reason = outcome.reason or "not_found"
        state.log(f"restore refused ({reason}): {original_id}")
        return JSONResponse(
            {"error": reason, "state": outcome.state, "root": outcome.root, "path": outcome.path},
            status_code=RESTORE_REFUSAL_STATUS.get(reason, 409),
        )
    return JSONResponse({"restored": True, "root": outcome.root, "path": outcome.path, "previous_state": outcome.state})


async def delete(request: Request) -> JSONResponse:
    state: ServerState = request.app.state.server_state
    body = await _json_body(request)
    original_id = body.get("id")
    if not isinstance(original_id, str):
        return JSONResponse({"error": "id is required"}, status_code=400)
    def perform_delete() -> bool:
        conn = state.conn_factory()
        try:
            return delete_original(conn, state.state_dir, state.originals, original_id)
        finally:
            conn.close()

    if not await run_in_threadpool(perform_delete):
        return JSONResponse({"error": "not found"}, status_code=404)
    state.log(f"deleted kept original: {original_id}")
    return JSONResponse({"deleted": True})


def create_app(state: ServerState) -> Starlette:
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/stats", stats, methods=["GET"]),
            Route("/activity", activity, methods=["GET"]),
            Route("/run", trigger_run, methods=["POST"]),
            Route("/originals", originals, methods=["GET"]),
            Route("/originals/download", download_original, methods=["GET"]),
            Route("/originals/restore", restore, methods=["POST"]),
            Route("/originals/delete", delete, methods=["POST"]),
        ]
    )
    app.state.server_state = state
    return app
