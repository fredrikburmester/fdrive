from __future__ import annotations

import threading

import psycopg
import pytest

from fdrive_ocr import db
from fdrive_ocr.runner import FILES_ROOT_ID, FILES_ROOT_NAME


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


def test_read_settings_empty(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.read_settings(conn) == {}
    finally:
        conn.close()


def test_a_recorded_decision_marks_its_content_done_wherever_it_lies(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.is_done(conn, "a" * 64) is False
        db.record_ocr_log(conn, FILES_ROOT_ID, "a.pdf", 100, 111, "a" * 64, "has_text", None)
        assert db.is_done(conn, "a" * 64) is True
        assert db.is_done(conn, "b" * 64) is False
    finally:
        conn.close()


def test_record_ocr_log_upserts_on_conflict(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        db.record_ocr_log(conn, FILES_ROOT_ID, "a.pdf", 100, 111, "a" * 64, "failed", "boom")
        db.record_ocr_log(conn, FILES_ROOT_ID, "a.pdf", 100, 111, "b" * 64, "ocred", None)
        with conn.cursor() as cur:
            cur.execute(
                'SELECT sha256, status, detail FROM "idx"."ocr_log" WHERE root_id = %s AND path = %s', (FILES_ROOT_ID, "a.pdf")
            )
            assert cur.fetchall() == [("b" * 64, "ocred", None)]
    finally:
        conn.close()


def test_pdf_candidates_leave_out_content_decided_at_another_path(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        for path, digest in (("b.pdf", "b" * 64), ("a.pdf", "a" * 64), ("done.pdf", "d" * 64), ("c.PDF", "e" * 64)):
            conn.execute(
                'INSERT INTO "idx"."files" (root_id, path, name, ext, size, mtime_ns, sha256) '
                "VALUES (%s, %s, %s, '.pdf', 10, 20, %s)",
                (FILES_ROOT_ID, path, path, digest),
            )
        db.record_ocr_log(conn, FILES_ROOT_ID, "elsewhere.pdf", 10, 20, "d" * 64, "has_text", None)

        assert db.pdf_candidates(conn, FILES_ROOT_ID, ()) == [
            db.IndexedPdf("a.pdf", 10, 20, "a" * 64),
            db.IndexedPdf("b.pdf", 10, 20, "b" * 64),
            db.IndexedPdf("c.PDF", 10, 20, "e" * 64),
        ]
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


def test_journal_change_waits_for_the_journal_lock_so_positions_commit_in_order(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    holder = psycopg.connect(postgres_dsn)
    try:
        holder.execute(db.JOURNAL_LOCK)  # held until `holder` commits
        logs: list[str] = []
        writer = threading.Thread(
            target=db.journal_change, args=(conn, FILES_ROOT_ID, FILES_ROOT_NAME, "a.pdf", logs.append)
        )
        writer.start()
        writer.join(timeout=0.5)
        assert writer.is_alive()
        holder.commit()
        writer.join(timeout=10)
        assert not writer.is_alive()
        assert logs == []
        rows = conn.execute('SELECT path, target_path, source FROM "idx"."changes"').fetchall()
        assert rows == [("a.pdf", None, "ocr")]
    finally:
        holder.close()
        conn.close()
