from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest
from psycopg.types.json import Json
from starlette.testclient import TestClient

from fdrive_ocr import db, runner, server
from fdrive_ocr.features import FEATURES_KEY
from fdrive_ocr.runner import RootTarget
from fdrive_ocr.settings import Settings

FIXED_NOW = datetime(2026, 1, 1, 1, 0, tzinfo=UTC)
DEFAULT_SETTINGS = Settings(
    hour=3, langs="swe+eng", exclude_globs=("Programs/**",), max_mb=200, keep_originals=True, originals_retention_days=0
)


def _set_pdf_ocr(state: server.ServerState) -> None:
    values = {
        "thumbnails": False,
        "textSearch": False,
        "searchOcr": False,
        "semanticSearch": False,
        "imageSearch": False,
        "pdfOcr": True,
    }
    conn = state.conn_factory()
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            (FEATURES_KEY, Json({"version": 1, "revision": 1, "values": values})),
        )
    conn.close()


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
    assert resp.json()["ok"] is True
    assert resp.json()["running"] is False
    assert resp.json()["features"]["revision"] == 0


def test_health_not_ok_when_schema_not_ready(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path, schema_ready=False)
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    assert resp.json()["ok"] is False


def test_storage_diagnostics_reports_missing_or_readable_roots(tmp_path: Path) -> None:
    diagnostics = server.storage_diagnostics(
        [
            RootTarget(name="mounted", root_id=1, abs_path=str(tmp_path)),
            RootTarget(name="missing", root_id=2, abs_path=str(tmp_path / "missing")),
        ]
    )
    assert diagnostics["mounted"]["readable"] is True
    assert diagnostics["missing"] == {"readable": False, "writable": False}


def test_health_reports_running(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    state.run_lock.try_acquire()
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    assert resp.json()["running"] is True


def test_missing_feature_selection_is_acknowledged_and_rejects_manual_run(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    client = TestClient(server.create_app(state))
    assert client.get("/health").json()["features"]["values"]["pdfOcr"] is False
    response = client.post("/run")
    assert response.status_code == 409
    assert response.json() == {"error": "PDF OCR disabled"}


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
    _set_pdf_ocr(state)
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
    _set_pdf_ocr(state)
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
    _set_pdf_ocr(state)
    state.run_lock.try_acquire()
    client = TestClient(server.create_app(state))
    resp = client.post("/run")
    assert resp.status_code == 409
    assert resp.json() == {"error": "already running"}


def test_run_releases_lock_and_logs_when_pass_crashes(postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    _set_pdf_ocr(state)
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


def test_run_lock_released_when_thread_start_fails(postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    _set_pdf_ocr(state)
    with TestClient(server.create_app(state)) as client:
        def fail_start(_self: object) -> None:
            raise RuntimeError("thread limit")

        monkeypatch.setattr(server.threading.Thread, "start", fail_start)
        response = client.post("/run")
        assert response.status_code == 500
        assert not state.run_lock.running
        assert state.run_lock.snapshot()["operations"][0]["state"] == "failed"


def test_activity_counts_done_skips_and_errors_without_storage_reads(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    def forbidden():
        raise AssertionError("Activity must not query the database or scan originals")
    state.conn_factory = forbidden
    client = TestClient(server.create_app(state))
    lock = state.run_lock
    assert client.get("/activity").json()["operations"] == []
    assert lock.try_acquire()
    lock.begin(7)
    lock.advance("skipped_done", False)
    lock.advance("ocred", True)
    lock.advance("timeout", False)
    operation = client.get("/activity").json()["operations"][0]
    assert operation["revision"] == 7
    assert operation["processed"] == 3 and operation["errors"] == 1 and operation["skipped"] == 1
    assert operation["total"] is None and operation["state"] == "running"
    lock.release()
    assert client.get("/activity").json()["operations"][0]["state"] == "failed"
    assert lock.try_acquire()
    lock.stop()
    lock.release()
    newer = client.get("/activity").json()["operations"][0]
    assert newer["id"] != operation["id"] and newer["state"] == "stopped"


# -- /originals ---------------------------------------------------------------------


def _keep_original(state: server.ServerState, root: Path, rel_path: str = "docs/scan.pdf") -> str:
    """Rewrites one file through `apply_rewrite` so the state directory holds a
    kept original with its sidecar, exactly as a pass would leave it."""
    source = root / rel_path
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"OK\noriginal\n")
    info = source.stat()
    rewritten = root / "rewritten.pdf"
    rewritten.write_bytes(b"OK-OCRED-OUTPUT\n")
    runner.apply_rewrite(
        str(source), str(rewritten), state.state_dir, "sftpgo", rel_path, info.st_size, info.st_mtime_ns, True
    )
    state.originals.invalidate()
    return os.path.basename(runner.originals_dest(state.state_dir, "sftpgo", rel_path, info.st_size, info.st_mtime_ns))


def test_originals_lists_kept_files_with_their_source_path(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    body = TestClient(server.create_app(state)).get("/originals").json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == original_id
    assert body["items"][0]["path"] == "docs/scan.pdf"
    assert body["items"][0]["state"] == "changed"


def test_originals_are_administrable_while_pdf_ocr_is_switched_off(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    client = TestClient(server.create_app(state))

    assert client.post("/run").status_code == 409  # the feature gate still applies to a pass
    assert client.get("/originals").json()["total"] == 1
    assert client.post("/originals/restore", json={"id": original_id, "allow_overwrite_changed": True}).status_code == 200
    assert (tmp_path / "docs" / "scan.pdf").read_bytes() == b"OK\noriginal\n"


def test_originals_pages_and_searches(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    _keep_original(state, tmp_path, "docs/invoice.pdf")
    _keep_original(state, tmp_path, "photos/holiday.pdf")
    client = TestClient(server.create_app(state))

    assert client.get("/originals", params={"limit": 1}).json()["total"] == 2
    assert len(client.get("/originals", params={"limit": 1}).json()["items"]) == 1
    found = client.get("/originals", params={"query": "holiday"}).json()
    assert [item["path"] for item in found["items"]] == ["photos/holiday.pdf"]


def test_originals_ignores_unparsable_paging_parameters(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    _keep_original(state, tmp_path)
    body = TestClient(server.create_app(state)).get("/originals", params={"limit": "many", "offset": "-4"}).json()
    assert (body["limit"], body["offset"]) == (server.DEFAULT_PAGE_LIMIT, 0)
    assert body["total"] == 1


def test_originals_clamps_an_oversized_page(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    body = TestClient(server.create_app(state)).get("/originals", params={"limit": "100000"}).json()
    assert body["limit"] == server.MAX_PAGE_LIMIT


def test_download_streams_the_kept_bytes(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    resp = TestClient(server.create_app(state)).get("/originals/download", params={"id": original_id})
    assert resp.status_code == 200
    assert resp.content == b"OK\noriginal\n"
    assert resp.headers["content-type"] == "application/pdf"


def test_download_404s_for_an_unknown_original(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    client = TestClient(server.create_app(state))
    assert client.get("/originals/download", params={"id": "nope.pdf"}).status_code == 404
    assert client.get("/originals/download", params={"id": "../../etc/passwd"}).status_code == 404


def test_restore_reports_the_refusal_that_needs_an_opt_in(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    client = TestClient(server.create_app(state))

    refused = client.post("/originals/restore", json={"id": original_id})
    assert refused.status_code == 409
    assert refused.json()["error"] == "target_changed"
    assert refused.json()["state"] == "changed"
    assert (tmp_path / "docs" / "scan.pdf").read_bytes() == b"OK-OCRED-OUTPUT\n"


def test_restore_404s_for_an_unknown_original(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    resp = TestClient(server.create_app(state)).post("/originals/restore", json={"id": "nope.pdf"})
    assert resp.status_code == 404
    assert resp.json()["error"] == "not_found"


@pytest.mark.parametrize("body", [{}, {"id": 5}, "not-an-object"])
def test_restore_and_delete_require_an_identifier(postgres_dsn: str, tmp_path: Path, body: object) -> None:
    client = TestClient(server.create_app(_make_state(postgres_dsn, tmp_path)))
    assert client.post("/originals/restore", json=body).status_code == 400
    assert client.post("/originals/delete", json=body).status_code == 400


def test_restore_rejects_a_body_that_is_not_json(postgres_dsn: str, tmp_path: Path) -> None:
    client = TestClient(server.create_app(_make_state(postgres_dsn, tmp_path)))
    assert client.post("/originals/restore", content=b"{").status_code == 400


def test_delete_removes_a_kept_original(postgres_dsn: str, tmp_path: Path) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    client = TestClient(server.create_app(state))

    assert client.post("/originals/delete", json={"id": original_id}).status_code == 200
    assert client.get("/originals").json()["total"] == 0
    assert client.post("/originals/delete", json={"id": original_id}).status_code == 404


@pytest.mark.parametrize("operation", ["restore", "delete"])
def test_original_mutation_does_not_block_health(
    postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    state = _make_state(postgres_dsn, tmp_path)
    original_id = _keep_original(state, tmp_path)
    started, release = threading.Event(), threading.Event()
    original = getattr(server, f"{operation}_original")

    def paused(*args: object) -> object:
        started.set()
        assert release.wait(10)
        return original(*args)

    monkeypatch.setattr(server, f"{operation}_original", paused)
    with TestClient(server.create_app(state)) as client, ThreadPoolExecutor(max_workers=2) as pool:
        mutation = pool.submit(
            client.post, f"/originals/{operation}", json={"id": original_id, "allow_overwrite_changed": True},
        )
        try:
            assert started.wait(5)
            health = pool.submit(client.get, "/health").result(timeout=3)
            assert health.status_code == 200
            assert not mutation.done()
        finally:
            release.set()
        assert mutation.result(timeout=5).status_code == 200


def test_a_manual_run_prunes_aged_originals(postgres_dsn: str, tmp_path: Path) -> None:
    # The root is a subdirectory so the pass does not walk into the state
    # directory and treat the kept originals themselves as candidate PDFs.
    root = tmp_path / "root"
    root.mkdir()
    root_id = db.upsert_root(db.connect(postgres_dsn), "sftpgo")
    state = _make_state(postgres_dsn, tmp_path, targets=[RootTarget(name="sftpgo", root_id=root_id, abs_path=str(root))])
    _set_pdf_ocr(state)
    original_id = _keep_original(state, root)
    conn = state.conn_factory()
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            ("ocr.originals_retention_days", Json(1)),
        )
    conn.close()
    sidecar = Path(state.state_dir, "original-mappings", f"{original_id}.json")
    document = json.loads(sidecar.read_text())
    sidecar.write_text(json.dumps({**document, "kept_at_ns": str(int((time.time() - 86400 * 5) * 1_000_000_000))}))
    state.originals.invalidate()

    client = TestClient(server.create_app(state))
    assert client.post("/run").status_code == 202
    assert _wait_until(lambda: not state.run_lock.running)
    assert client.get("/originals").json()["total"] == 0
