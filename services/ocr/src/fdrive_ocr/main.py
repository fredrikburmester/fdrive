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
from .features import resolve_features
from .restore import OriginalsIndex, prune_originals
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
    include_globs: tuple[str, ...] = (),
    originals: OriginalsIndex | None = None,
) -> bool:
    """Attempts one pass, then prunes kept originals the retention window has
    aged out. Returns whether it actually ran: `False` means a run was already
    in progress and this cycle was skipped."""
    if not run_lock.try_acquire():
        log_fn("scheduled OCR pass skipped: a run is already in progress")
        return False
    try:
        conn = conn_factory()
        try:
            raw = db.read_settings(conn)
            feature_config = resolve_features(raw)
            if not feature_config.values.pdf_ocr:
                run_lock.stop()
                log_fn("OCR pass skipped: PDF OCR disabled")
                return False
            run_lock.begin(feature_config.revision)
            settings = resolve_settings(raw, default_settings)
            run_pass(
                conn,
                targets,
                settings,
                state_dir,
                timeout_seconds,
                jobs,
                log_fn,
                include_globs,
                is_enabled=lambda: resolve_features(db.read_settings(conn)).values.pdf_ocr,
                on_file=run_lock.advance, on_stopped=run_lock.stop,
            )
            prune_originals(
                state_dir, originals if originals is not None else OriginalsIndex(), settings.originals_retention_days, log_fn
            )
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        run_lock.fail()
        log_fn(f"OCR pass crashed: {type(e).__name__}: {e}")
    finally:
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
    include_globs: tuple[str, ...] = (),
    settings_refresh_seconds: int = 5,
    originals: OriginalsIndex | None = None,
) -> None:
    """Runs forever: re-reads settings each cycle (an admin edit to `ocr.hour`
    takes effect on the next wakeup), computes the next scheduled hour, sleeps
    until then, runs a pass, repeats."""
    if run_on_start:
        run_once(
            run_lock,
            conn_factory,
            targets,
            default_settings,
            state_dir,
            timeout_seconds,
            jobs,
            log_fn,
            include_globs,
            originals,
        )

    refresh_wait_s = max(1, settings_refresh_seconds)
    last_logged_schedule: tuple[bool, datetime | None] | None = None
    while True:
        try:
            conn = conn_factory()
            try:
                raw = db.read_settings(conn)
                features = resolve_features(raw)
                hour = resolve_settings(raw, default_settings).hour
            finally:
                conn.close()
        except Exception as e:  # noqa: BLE001
            log_fn(f"OCR scheduler settings refresh failed: {type(e).__name__}: {e}")
            # Log the resolved state again after recovery, even when it matches
            # the state from before the database failure.
            last_logged_schedule = None
            sleep(refresh_wait_s)
            continue
        current = now()
        if not features.values.pdf_ocr:
            target = None
            wait_s: float = refresh_wait_s
        else:
            target = next_run_at(current, hour)
            wait_s = min(seconds_until(current, target), refresh_wait_s)
        schedule = (features.values.pdf_ocr, target)
        if schedule != last_logged_schedule:
            if target is None:
                log_fn("OCR scheduler idle: PDF OCR disabled")
            else:
                log_fn(f"next OCR pass at {target.isoformat()}")
            last_logged_schedule = schedule
        sleep(wait_s)
        if not features.values.pdf_ocr:
            continue
        # Short waits are only for configuration polling. Do not turn a nightly
        # schedule into a five-second rewrite loop while PDF OCR is enabled.
        if target is None or now() < target:
            continue
        run_once(
            run_lock,
            conn_factory,
            targets,
            default_settings,
            state_dir,
            timeout_seconds,
            jobs,
            log_fn,
            include_globs,
            originals,
        )


def main() -> None:
    cfg = Config()
    bootstrap_conn = db.connect(cfg.database_url)
    try:
        log(f"waiting for idx.schema_version = {EXPECTED_SCHEMA_VERSION} (timeout {cfg.schema_wait_seconds}s)")
        version = db.wait_for_schema_version(bootstrap_conn, EXPECTED_SCHEMA_VERSION, cfg.schema_wait_seconds, log)
        if version is None:
            sys.exit(1)
        log(f"schema ready at version {version}")

        targets = build_targets(bootstrap_conn, cfg.roots)
    finally:
        bootstrap_conn.close()
    run_lock = RunLock()
    # One scan of the kept originals, shared by the scheduler's prune and the
    # HTTP handlers that list and total them.
    originals_index = OriginalsIndex()

    def scheduler_conn_factory() -> psycopg.Connection:
        return db.connect(cfg.database_url)

    def conn_factory() -> psycopg.Connection:
        # HTTP handlers must fail quickly while Postgres is unavailable. A
        # later probe opens a new connection, so recovery needs no process
        # restart. The scheduler keeps the normal startup retry budget.
        return db.connect(cfg.database_url, retries=1, sleep=lambda _seconds: None)

    def schema_ready() -> bool:
        conn = conn_factory()
        try:
            return db.read_schema_version(conn) is not None
        finally:
            conn.close()

    tz = resolve_timezone(cfg.tz_name)

    thread = threading.Thread(
        target=scheduler_loop,
        args=(
            run_lock,
            scheduler_conn_factory,
            targets,
            cfg.default_settings(),
            cfg.state_dir,
            cfg.timeout_seconds,
            cfg.jobs,
            cfg.run_on_start,
            log,
            lambda: datetime.now(tz),
        ),
        kwargs={
            "include_globs": cfg.include_globs,
            "settings_refresh_seconds": cfg.settings_refresh_seconds,
            "originals": originals_index,
        },
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
        schema_ready=schema_ready,
        log=log,
        originals=originals_index,
        include_globs=cfg.include_globs,
    )
    app = create_app(state)
    log(f"ocr up. roots={list(cfg.roots)} port={cfg.ocr_port}")
    uvicorn.run(app, host="0.0.0.0", port=cfg.ocr_port, log_level="warning")  # noqa: S104 - compose-network only


if __name__ == "__main__":
    main()
