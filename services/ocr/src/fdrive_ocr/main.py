"""Entrypoint: wait for the schema handshake, build the configured root
targets, run the nightly scheduler loop in a background thread, and serve the
internal HTTP API. `python -m fdrive_ocr.main`.
"""

from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime

import psycopg
import uvicorn

from . import db
from .config import Config
from .runner import RootTarget, run_pass
from .schedule import next_run_at, resolve_timezone, seconds_until
from .server import RunLock, ServerState, create_app
from .settings import Settings, resolve_settings

EXPECTED_SCHEMA_VERSION = 1


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def build_targets(conn: psycopg.Connection, roots: dict[str, str]) -> list[RootTarget]:
    return [RootTarget(name=name, root_id=db.upsert_root(conn, name), abs_path=abs_path) for name, abs_path in roots.items()]


def run_once(
    run_lock: RunLock,
    conn_factory: Callable[[], psycopg.Connection],
    targets: list[RootTarget],
    default_settings: Settings,
    state_dir: str,
    timeout_seconds: int,
    jobs: int,
    log_fn: Callable[[str], None],
) -> bool:
    """Attempts one pass. Returns whether it actually ran: `False` means a run
    was already in progress and this cycle was skipped."""
    if not run_lock.try_acquire():
        log_fn("scheduled OCR pass skipped: a run is already in progress")
        return False
    conn = conn_factory()
    try:
        raw = db.read_settings(conn)
        settings = resolve_settings(raw, default_settings)
        run_pass(conn, targets, settings, state_dir, timeout_seconds, jobs, log_fn)
    except Exception as e:  # noqa: BLE001
        log_fn(f"OCR pass crashed: {type(e).__name__}: {e}")
    finally:
        conn.close()
        run_lock.release()
    return True


def scheduler_loop(
    run_lock: RunLock,
    conn_factory: Callable[[], psycopg.Connection],
    targets: list[RootTarget],
    default_settings: Settings,
    state_dir: str,
    timeout_seconds: int,
    jobs: int,
    run_on_start: bool,
    log_fn: Callable[[str], None],
    now: Callable[[], datetime],
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Runs forever: re-reads settings each cycle (an admin edit to `ocr.hour`
    takes effect on the next wakeup), computes the next scheduled hour, sleeps
    until then, runs a pass, repeats."""
    if run_on_start:
        run_once(run_lock, conn_factory, targets, default_settings, state_dir, timeout_seconds, jobs, log_fn)

    while True:
        conn = conn_factory()
        try:
            raw = db.read_settings(conn)
            hour = resolve_settings(raw, default_settings).hour
        finally:
            conn.close()
        current = now()
        target = next_run_at(current, hour)
        wait_s = seconds_until(current, target)
        log_fn(f"next OCR pass at {target.isoformat()}")
        sleep(wait_s)
        run_once(run_lock, conn_factory, targets, default_settings, state_dir, timeout_seconds, jobs, log_fn)


def main() -> None:
    cfg = Config()
    if not cfg.roots:
        log("no INDEX_ROOTS configured; nothing to do")
        sys.exit(1)

    bootstrap_conn = db.connect(cfg.database_url)
    log(f"waiting for idx.schema_version = {EXPECTED_SCHEMA_VERSION} (timeout {cfg.schema_wait_seconds}s)")
    version = db.wait_for_schema_version(bootstrap_conn, EXPECTED_SCHEMA_VERSION, cfg.schema_wait_seconds, log)
    if version is None:
        sys.exit(1)
    log(f"schema ready at version {version}")

    targets = build_targets(bootstrap_conn, cfg.roots)
    run_lock = RunLock()

    def conn_factory() -> psycopg.Connection:
        return db.connect(cfg.database_url)

    tz = resolve_timezone(cfg.tz_name)

    thread = threading.Thread(
        target=scheduler_loop,
        args=(
            run_lock,
            conn_factory,
            targets,
            cfg.default_settings(),
            cfg.state_dir,
            cfg.timeout_seconds,
            cfg.jobs,
            cfg.run_on_start,
            log,
            lambda: datetime.now(tz),
        ),
        daemon=True,
        name="ocr-scheduler",
    )
    thread.start()

    state = ServerState(
        conn_factory=conn_factory,
        targets=targets,
        state_dir=cfg.state_dir,
        default_settings=cfg.default_settings(),
        timeout_seconds=cfg.timeout_seconds,
        jobs=cfg.jobs,
        run_lock=run_lock,
        now=lambda: datetime.now(tz),
        schema_ready=lambda: db.read_schema_version(bootstrap_conn) is not None,
        log=log,
    )
    app = create_app(state)
    log(f"ocr up. roots={list(cfg.roots)} port={cfg.ocr_port}")
    uvicorn.run(app, host="0.0.0.0", port=cfg.ocr_port, log_level="warning")  # noqa: S104 - compose-network only


if __name__ == "__main__":
    main()
