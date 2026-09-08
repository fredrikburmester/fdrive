"""Pure shaping of the `/health` and `/stats` response bodies from data the I/O
layer (`db.py`, `runner.py`, `server.py`) already fetched. No querying here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RunSummary:
    started_at: str
    finished_at: str | None
    seen: int
    ocred: int
    skipped: int
    failed: int


def shape_health(ok: bool, running: bool, features: dict[str, Any] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"ok": ok, "running": running}
    if features is not None:
        body["features"] = features
    return body


def shape_stats(
    last_run: RunSummary | None,
    next_run_at: str,
    schedule_hour: int,
    langs: str,
    exclude_globs: list[str],
    max_mb: int,
    keep_originals: bool,
    originals_count: int,
    originals_bytes: int,
    running: bool,
    features: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = {
        "last_run": (
            {
                "started_at": last_run.started_at,
                "finished_at": last_run.finished_at,
                "seen": last_run.seen,
                "ocred": last_run.ocred,
                "skipped": last_run.skipped,
                "failed": last_run.failed,
            }
            if last_run is not None
            else None
        ),
        "next_run_at": next_run_at,
        "schedule_hour": schedule_hour,
        "langs": langs,
        "exclude_globs": list(exclude_globs),
        "max_mb": max_mb,
        "keep_originals": keep_originals,
        "originals_count": originals_count,
        "originals_bytes": originals_bytes,
        "running": running,
    }
    if features is not None:
        body["features"] = features
    return body
