from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from fdrive_ocr import db, server
from fdrive_ocr.runner import RootTarget
from fdrive_ocr.settings import Settings

FIXED_NOW = datetime(2026, 1, 1, 1, 0, tzinfo=UTC)
DEFAULT_SETTINGS = Settings(
    hour=3, langs="swe+eng", exclude_globs=("Programs/**",), max_mb=200, keep_originals=True
)


def _make_state(
    postgres_dsn: str,
    tmp_path: Path,
    schema_ready: bool = True,
    targets: list[RootTarget] | None = None,
    include_globs: tuple[str, ...] = (),
) -> server.ServerState:
    root_id = db.upsert_root(db.connect(postgres_dsn), "sftpgo")
    resolved_targets = targets if targets is not None else [RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))]
    return server.ServerState(
        conn_factory=lambda: db.connect(postgres_dsn),
        targets=resolved_targets,
        state_dir=str(tmp_path / "state"),
        default_settings=DEFAULT_SETTINGS,
        timeout_seconds=30,
        jobs=2,
        run_lock=server.RunLock(),
        now=lambda: FIXED_NOW,
        schema_ready=lambda: schema_ready,
        log=lambda _msg: None,
        include_globs=include_globs,
    )


def _wait_until(predicate: object, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(interval)
    return predicate()  # type: ignore[operator]


# -- RunLock --------------------------------------------------------------------


def test_run_lock_prevents_double_acquire() -> None:
    lock = server.RunLock()
    assert lock.try_acquire() is True
    assert lock.running is True
    assert lock.try_acquire() is False
    lock.release()
    assert lock.running is False
    assert lock.try_acquire() is True


# -- /health ----------------------------------------------------------------------


def test_health_ok_and_not_running(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "running": False}


def test_health_not_ok_when_schema_not_ready(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path, schema_ready=False)
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    assert resp.json()["ok"] is False


def test_health_reports_running(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    state.run_lock.try_acquire()
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    assert resp.json()["running"] is True


# -- /stats -----------------------------------------------------------------------


def test_stats_with_no_runs_yet(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    client = TestClient(server.create_app(state))
    resp = client.get("/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["last_run"] is None
    assert body["schedule_hour"] == 3
    assert body["langs"] == "swe+eng"
    assert body["max_mb"] == 200
    assert body["keep_originals"] is True
    assert body["originals_count"] == 0
    assert body["originals_bytes"] == 0
    assert body["running"] is False
    assert body["next_run_at"] == "2026-01-01T03:00:00+00:00"


def test_stats_reflects_settings_overrides(postgres_dsn: str, tmp_path: Path) -> None:
    import psycopg.types.json

    state = _make_state(postgres_dsn, tmp_path)
    conn = state.conn_factory()
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            ("ocr.hour", psycopg.types.json.Json(5)),
        )
    conn.close()
    client = TestClient(server.create_app(state))
    resp = client.get("/stats")
    body = resp.json()
    assert body["schedule_hour"] == 5
    assert body["next_run_at"] == "2026-01-01T05:00:00+00:00"


def test_stats_counts_originals_on_disk(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    originals = tmp_path / "state" / "originals"
    originals.mkdir(parents=True)
    (originals / "a").write_bytes(b"12345")
    client = TestClient(server.create_app(state))
    resp = client.get("/stats")
    body = resp.json()
    assert body["originals_count"] == 1
    assert body["originals_bytes"] == 5


def test_stats_reports_last_run(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    conn = state.conn_factory()
    run_id = db.start_run(conn)
    db.finish_run(conn, run_id, seen=3, ocred=1, skipped=2, failed=0)
    conn.close()
    client = TestClient(server.create_app(state))
    resp = client.get("/stats")
    body = resp.json()
    assert body["last_run"]["seen"] == 3
    assert body["last_run"]["ocred"] == 1


# -- /run -------------------------------------------------------------------------


def test_run_starts_a_pass_and_stats_reflects_it(postgres_dsn: str, tmp_path: Path) -> None:
    from fdrive_ocr.decide import STATUS_HAS_TEXT  # noqa: F401  (documents fixture marker meaning)

    (tmp_path / "a.pdf").write_bytes(b"HASTEXT\n")
    state = _make_state(postgres_dsn, tmp_path)
    client = TestClient(server.create_app(state))

    resp = client.post("/run")
    assert resp.status_code == 202
    assert resp.json() == {"started": True}

    assert _wait_until(lambda: not state.run_lock.running)

    stats_resp = client.get("/stats")
    body = stats_resp.json()
    assert body["last_run"] is not None
    assert body["last_run"]["seen"] == 1
    assert body["last_run"]["skipped"] == 1


def test_run_applies_the_state_include_globs(postgres_dsn: str, tmp_path: Path) -> None:
    (tmp_path / "fredrik").mkdir()
    (tmp_path / "fredrik" / "in-scope.pdf").write_bytes(b"HASTEXT\n")
    (tmp_path / "alice").mkdir()
    (tmp_path / "alice" / "out-of-scope.pdf").write_bytes(b"HASTEXT\n")
    state = _make_state(postgres_dsn, tmp_path, include_globs=("sftpgo/fredrik/**",))
    client = TestClient(server.create_app(state))

    resp = client.post("/run")
    assert resp.status_code == 202
    assert _wait_until(lambda: not state.run_lock.running)

    conn = state.conn_factory()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT path, status FROM "idx"."ocr_log" WHERE root_id = %s', (state.targets[0].root_id,))
            statuses = dict(cur.fetchall())
    finally:
        conn.close()
    assert statuses[str(Path("alice") / "out-of-scope.pdf")] == "excluded"
    assert statuses[str(Path("fredrik") / "in-scope.pdf")] == "has_text"


def test_run_returns_409_when_already_running(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    state.run_lock.try_acquire()
    client = TestClient(server.create_app(state))
    resp = client.post("/run")
    assert resp.status_code == 409
    assert resp.json() == {"error": "already running"}


def test_run_releases_lock_and_logs_when_pass_crashes(
    postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    logs: list[str] = []
    state.log = logs.append

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(server, "run_pass", boom)
    client = TestClient(server.create_app(state))
    resp = client.post("/run")
    assert resp.status_code == 202
    assert _wait_until(lambda: not state.run_lock.running)
    assert any("crashed" in line for line in logs)
