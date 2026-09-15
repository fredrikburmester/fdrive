"""Restore safety with real files, PostgreSQL locks and controlled interleavings."""
from __future__ import annotations

import os
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path

import psycopg
import pytest

from fdrive_ocr import db, restore, runner
from fdrive_ocr.runner import RootTarget
from fdrive_ocr.settings import default_settings

ORIGINAL = b"OK\nthe first original scan\n"
KeptOriginal = tuple[RootTarget, str, str, Path]


@pytest.fixture
def kept_original(db_conn: psycopg.Connection, tmp_path: Path) -> KeptOriginal:
    root = tmp_path / "root"
    root.mkdir()
    source = root / "scan.pdf"
    source.write_bytes(ORIGINAL)
    os.utime(source, ns=(1_750_000_000_000_000_000,) * 2)
    target = RootTarget("review", db.upsert_root(db_conn, "review"), str(root))
    state = str(tmp_path / "state")
    runner.run_pass(db_conn, [target], default_settings(), state, 30, 1, lambda _: None)
    return target, state, restore.scan_originals(state)[0].id, source


def put_back(conn: psycopg.Connection, original: KeptOriginal, allow: bool = False) -> restore.RestoreOutcome:
    target, state, original_id, _source = original
    return restore.restore_original(
        conn, state, [target], restore.OriginalsIndex(), original_id, allow, allow, lambda _: None,
    )


@pytest.mark.parametrize("change", ["edit", "delete", "replace", "in_place", "recreate", "already_changed"])
def test_refuses_destination_changes_during_copy(
    db_conn: psycopg.Connection, kept_original: KeptOriginal, monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    _target, _state, _original_id, source = kept_original
    if change == "recreate":
        source.unlink()
    elif change == "already_changed":
        source.write_bytes(b"OK\nalready edited before restore\n")
    copy_verified = restore._copy_verified
    edited = b"OK\na user saved these new bytes during restore\n"

    def copy_then_change(original: str, directory: str) -> tuple[str, str]:
        nonlocal edited
        result = copy_verified(original, directory)
        if change == "delete":
            source.unlink()
        elif change in ("replace", "in_place"):
            # Same size and mtime must still detect an atomic save or in-place edit.
            before = source.stat()
            edited = b"X" * before.st_size
            if change == "replace":
                source.unlink()
            source.write_bytes(edited)
            os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
        else:
            source.write_bytes(edited)
        return result

    monkeypatch.setattr(restore, "_copy_verified", copy_then_change)
    outcome = put_back(db_conn, kept_original, allow=change in ("recreate", "already_changed"))
    assert not outcome.ok
    assert outcome.reason == ("target_missing" if change == "delete" else "target_changed")
    if change == "delete":
        assert not source.exists()
    else:
        assert source.read_bytes() == edited
    assert not list(source.parent.glob("._fdrive-restore-*"))


def test_older_original_requires_consent_for_a_later_ocred_revision(
    db_conn: psycopg.Connection, kept_original: KeptOriginal,
) -> None:
    target, state, original_id, source = kept_original
    source.write_bytes(b"OK\na second revision saved by the user\n")
    os.utime(source, ns=(1_750_000_001_000_000_000,) * 2)
    runner.run_pass(db_conn, [target], default_settings(), state, 30, 1, lambda _: None)
    before = source.read_bytes()
    listed, _ = restore.list_originals(db_conn, state, [target], restore.OriginalsIndex())
    assert next(item for item in listed if item.id == original_id).state == "changed"
    assert {item.state for item in listed} == {"ocred", "changed"}
    outcome = put_back(db_conn, kept_original)
    assert (outcome.ok, outcome.reason) == (False, "target_changed")
    assert source.read_bytes() == before
    assert put_back(db_conn, kept_original, allow=True).ok
    assert source.read_bytes() == ORIGINAL


def test_pass_refreshes_done_keys_after_a_restore(
    db_conn: psycopg.Connection, kept_original: KeptOriginal, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, state, _original_id, source = kept_original

    def restore_after_snapshot(_root: str) -> Iterator[str]:
        assert put_back(db_conn, kept_original).ok
        yield str(source)

    monkeypatch.setattr(runner, "iter_candidate_pdfs", restore_after_snapshot)
    totals = runner.run_pass(db_conn, [target], default_settings(), state, 30, 1, lambda _: None)
    assert totals.ocred == 0
    assert source.read_bytes() == ORIGINAL


@pytest.mark.parametrize("exit_code", [0, 6])
def test_restore_during_ocr_keeps_bytes_and_receipt(
    db_conn: psycopg.Connection, kept_original: KeptOriginal, monkeypatch: pytest.MonkeyPatch, exit_code: int,
) -> None:
    target, state, original_id, source = kept_original
    kept = Path(restore.originals_dir(state), original_id)
    # A manual copy back has no done-log row yet, so the subprocess will start.
    source.write_bytes(kept.read_bytes())
    os.utime(source, ns=(kept.stat().st_mtime_ns,) * 2)

    def restore_during_ocr(src: str, dst: str, *_args: object) -> tuple[int, str, bool]:
        Path(dst).write_bytes(b"OCR would overwrite the restored file")
        assert put_back(db_conn, kept_original).ok
        return exit_code, "", False

    monkeypatch.setattr(runner, "run_ocrmypdf", restore_during_ocr)
    totals = runner.run_pass(db_conn, [target], default_settings(), state, 30, 1, lambda _: None)
    assert totals.ocred == 0
    assert source.read_bytes() == ORIGINAL
    row = db_conn.execute(
        'SELECT status FROM idx.ocr_log WHERE root_id=%s AND path=%s AND size=%s AND mtime_ns=%s',
        (target.root_id, "scan.pdf", len(ORIGINAL), source.stat().st_mtime_ns),
    ).fetchone()
    assert row == ("restored",)
    assert not list(source.parent.glob("._fdrive-ocr-*.pdf"))


def wait_for_lock(conn: psycopg.Connection, pid: int) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        row = conn.execute("SELECT wait_event FROM pg_stat_activity WHERE pid=%s", (pid,)).fetchone()
        if row == ("advisory",):
            return
        time.sleep(0.01)
    pytest.fail("worker did not wait for the advisory lock")


@pytest.mark.parametrize("operation", ["delete", "prune"])
def test_removing_originals_waits_for_backup(
    db_conn: psycopg.Connection, postgres_dsn: str, kept_original: KeptOriginal, operation: str,
) -> None:
    _target, state, original_id, _source = kept_original
    kept = Path(restore.originals_dir(state), original_id)
    sidecar = Path(restore.mappings_dir(state), f"{original_id}.json")
    with psycopg.connect(postgres_dsn, autocommit=True) as worker, ThreadPoolExecutor() as pool:
        db_conn.execute("SELECT pg_advisory_lock(%s)", (736591204,))
        try:
            if operation == "delete":
                future = pool.submit(restore.delete_original, worker, state, restore.OriginalsIndex(), original_id)
            else:
                future = pool.submit(
                    restore.prune_originals, worker, state, restore.OriginalsIndex(), 30, lambda _: None,
                    lambda: time.time() + 40 * 86400,
                )
            wait_for_lock(db_conn, worker.info.backend_pid)
            assert kept.exists() and sidecar.exists()
        finally:
            db_conn.execute("SELECT pg_advisory_unlock(%s)", (736591204,))
        assert future.result(timeout=5)
        assert not kept.exists() and not sidecar.exists()


@pytest.mark.parametrize("gate", ["file", "backup"])
def test_restore_checks_destination_after_waiting_for_locks(
    db_conn: psycopg.Connection, postgres_dsn: str, kept_original: KeptOriginal, gate: str,
) -> None:
    target, _state, _original_id, source = kept_original
    with psycopg.connect(postgres_dsn, autocommit=True) as worker, ThreadPoolExecutor() as pool:
        if gate == "backup":
            db_conn.execute("SELECT pg_advisory_lock(%s)", (736591204,))
        try:
            with db.ocr_file_lock(db_conn, target.root_id, "scan.pdf") if gate == "file" else nullcontext():
                future = pool.submit(put_back, worker, kept_original)
                wait_for_lock(db_conn, worker.info.backend_pid)
                source.write_bytes(b"a user edit made while restore waited")
        finally:
            if gate == "backup":
                db_conn.execute("SELECT pg_advisory_unlock(%s)", (736591204,))
        outcome = future.result(timeout=5)
        assert (outcome.ok, outcome.reason) == (False, "target_changed")
        assert source.read_bytes() == b"a user edit made while restore waited"


def test_file_lock_releases_after_a_failed_write(db_conn: psycopg.Connection, postgres_dsn: str) -> None:
    with pytest.raises(RuntimeError, match="write failed"), db.ocr_file_lock(db_conn, 1, "scan.pdf"):
        raise RuntimeError("write failed")
    with psycopg.connect(postgres_dsn, autocommit=True) as contender:
        assert contender.execute(
            "SELECT pg_try_advisory_lock(%s, hashtext(%s))", (736591207, "1:scan.pdf"),
        ).fetchone() == (True,)
