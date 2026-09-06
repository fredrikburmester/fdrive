from __future__ import annotations

import psycopg
import pytest

from fdrive_ocr import db


def test_connect_success(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert conn.execute("SELECT 1").fetchone() == (1,)
    finally:
        conn.close()


def test_connect_retries_then_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def fake_connect(dsn: str, autocommit: bool = True) -> None:
        calls["n"] += 1
        raise psycopg.OperationalError("nope")

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    sleeps: list[float] = []
    with pytest.raises(RuntimeError, match="could not connect"):
        db.connect("postgres://bad", retries=3, sleep=sleeps.append)
    assert calls["n"] == 3
    assert sleeps == [2, 2, 2]


def test_read_schema_version_present(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.read_schema_version(conn) == 1
    finally:
        conn.close()


def test_read_schema_version_handles_db_error(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        with conn.cursor() as cur:
            cur.execute('DROP TABLE "idx"."schema_version"')
        assert db.read_schema_version(conn) is None
    finally:
        with conn.cursor() as cur:
            cur.execute('CREATE TABLE "idx"."schema_version" (version integer PRIMARY KEY)')
            cur.execute('INSERT INTO "idx"."schema_version" (version) VALUES (1)')
        conn.close()


def test_wait_for_schema_version_immediate_match(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        logs: list[str] = []
        version = db.wait_for_schema_version(conn, 1, timeout_seconds=5, log=logs.append)
        assert version == 1
        assert logs == []
    finally:
        conn.close()


def test_wait_for_schema_version_times_out(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        logs: list[str] = []
        times = iter([0.0, 0.0, 100.0])
        version = db.wait_for_schema_version(
            conn, 99, timeout_seconds=5, log=logs.append, sleep=lambda _s: None, now=lambda: next(times)
        )
        assert version is None
        assert any("giving up" in line for line in logs)
    finally:
        conn.close()


def test_upsert_root_is_idempotent(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        first = db.upsert_root(conn, "sftpgo")
        second = db.upsert_root(conn, "sftpgo")
        assert first == second
    finally:
        conn.close()


def test_read_settings_empty(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.read_settings(conn) == {}
    finally:
        conn.close()


def test_record_ocr_log_and_done_keys(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        db.record_ocr_log(conn, root_id, "a.pdf", 100, 111, "has_text", None)
        assert db.done_keys(conn, root_id) == {("a.pdf", 100, 111)}
    finally:
        conn.close()


def test_record_ocr_log_upserts_on_conflict(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        db.record_ocr_log(conn, root_id, "a.pdf", 100, 111, "failed", "boom")
        db.record_ocr_log(conn, root_id, "a.pdf", 100, 111, "ocred", None)
        with conn.cursor() as cur:
            cur.execute('SELECT status, detail FROM "idx"."ocr_log" WHERE root_id = %s AND path = %s', (root_id, "a.pdf"))
            row = cur.fetchone()
            assert row is not None
            assert row[0] == "ocred"
            assert row[1] is None
    finally:
        conn.close()


def test_start_and_finish_run(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        run_id = db.start_run(conn)
        assert db.last_run(conn) is not None
        db.finish_run(conn, run_id, seen=10, ocred=2, skipped=7, failed=1)
        summary = db.last_run(conn)
        assert summary is not None
        assert summary.seen == 10
        assert summary.ocred == 2
        assert summary.skipped == 7
        assert summary.failed == 1
        assert summary.finished_at is not None
    finally:
        conn.close()


def test_last_run_none_when_no_runs(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.last_run(conn) is None
    finally:
        conn.close()


def test_last_run_orders_by_most_recent(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        first = db.start_run(conn)
        db.finish_run(conn, first, 1, 0, 1, 0)
        second = db.start_run(conn)
        db.finish_run(conn, second, 2, 1, 1, 0)
        summary = db.last_run(conn)
        assert summary is not None
        assert summary.seen == 2
    finally:
        conn.close()
