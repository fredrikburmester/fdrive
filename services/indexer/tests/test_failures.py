from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import psycopg
import pytest
from test_thumb_rebuild import _make_config, _make_context, _SyncThread, _upsert_media_file, _write_png

from fdrive_indexer import db, failures
from fdrive_indexer.failure_retry import retry_file, start_retry
from fdrive_indexer.features import FeatureConfiguration, FeatureValues
from fdrive_indexer.indexer import process_thumbnails, scan_once
from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob, rebuild_thumbnails


@pytest.fixture
def context(monkeypatch: pytest.MonkeyPatch, postgres_dsn: str, tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "photos", str(root))
    ctx.features = FeatureConfiguration(1, FeatureValues(True, False, False, False, False, False))
    yield ctx
    ctx.conn().close()


def records(conn: psycopg.Connection):
    return conn.execute(
        'SELECT feature, path, message, attempts, resolved_at, operation_id FROM idx.processing_failures ORDER BY id'
    ).fetchall()


def test_corrupt_image_survives_connection_restart_and_retry_resolves(context, postgres_dsn: str):
    source = Path(context.abs_path) / "broken.png"
    source.write_bytes(b"not a png")
    _upsert_media_file(context, source.name, ".png", source, "a" * 64)
    with failures.attempt({"thumbnails": "run-before-restart"}):
        rebuild_thumbnails(context)
    context.conn().close()
    with psycopg.connect(postgres_dsn, autocommit=True) as reopened:
        row = records(reopened)[0]
        assert row[0:2] == ("thumbnails", "broken.png")
        assert "UnidentifiedImageError" in row[2]
        assert row[3:] == (1, None, "run-before-restart")
    _write_png(source)
    assert retry_file(context, source.name, "thumbnails") == (True, False)
    assert records(context.conn())[0][4] is not None
    assert context.conn().execute('SELECT count(*) FROM app.thumbnails').fetchone()[0] == 2


def test_separate_roots_attempts_resolution_and_recurrence(context, monkeypatch: pytest.MonkeyPatch):
    other = _make_context(context.cfg, "other", context.abs_path)
    for _ in range(2):
        failures.report(context, "same.png", "thumbnails", print, "DecodeError: bad bytes")
    failures.report(other, "same.png", "thumbnails", print, "PermissionError: denied")
    assert [r[3] for r in records(context.conn())] == [2, 1]
    failures.report(context, "same.png", "thumbnails", print)
    assert records(context.conn())[0][4] is not None
    failures.report(context, "same.png", "thumbnails", print, "DecodeError: changed bytes")
    assert records(context.conn())[0][3:5] == (1, None)
    other.conn().close()


def test_image_failure_does_not_increment_thumbnail_counter(context, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import indexer

    source = Path(context.abs_path) / "good.png"
    _write_png(source)
    context.features = FeatureConfiguration(2, FeatureValues(True, False, False, False, True, False))
    def reject(*args, **kwargs):
        raise ValueError("model rejected image")
    monkeypatch.setattr(indexer, "embed_thumbnail", reject)
    assert scan_once(context)["errors"] == 1
    snapshots = {s["features"][0]: s for s in context.activity.snapshot()}
    assert snapshots["thumbnails"]["errors"] == 0
    assert snapshots["thumbnails"]["state"] == "completed"
    assert snapshots["imageSearch"]["errors"] == 1
    assert snapshots["imageSearch"]["state"] == "failed"
    assert records(context.conn())[0][0] == "imageSearch"


def test_skip_is_not_failure_or_false_recovery(context):
    failures.report(context, "empty.png", "thumbnails", print, "DecodeError: original issue")
    assert process_thumbnails(context, "/unused", "empty.png", ".png", "b" * 64, 0) == (True, True)
    assert records(context.conn())[0][4] is None


def test_video_without_picture_resolves_earlier_failure_as_skip(context, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import thumbs_io

    def audio_only(_path: str) -> object:
        raise thumbs_io.NoThumbnail("no video stream")

    monkeypatch.setattr(thumbs_io, "_extract_video_frame", audio_only)
    source = Path(context.abs_path) / "voice.mp4"
    source.write_bytes(b"audio only")
    _upsert_media_file(context, source.name, ".mp4", source, hashlib.sha256(source.read_bytes()).hexdigest())
    message = "CalledProcessError: Output file does not contain any stream"
    failures.report(context, source.name, "thumbnails", print, message)
    assert retry_file(context, source.name, "thumbnails") == (True, True)
    assert records(context.conn())[0][4] is not None

    failures.report(context, source.name, "thumbnails", print, message)
    outcomes: list[str] = []
    with failures.attempt() as observation:
        rebuild_thumbnails(context, on_file=lambda ok: outcomes.append(f"file:{ok}"), on_skip=lambda: outcomes.append("skip"))
    assert outcomes == ["skip"]
    assert observation.outcomes["thumbnails"] == (True, True)
    assert records(context.conn())[0][4] is not None
    assert context.conn().execute('SELECT count(*) FROM app.thumbnails').fetchone()[0] == 0


def test_retry_rejects_symlink_and_missing_file(context, tmp_path: Path):
    outside = tmp_path / "outside.png"
    _write_png(outside)
    (Path(context.abs_path) / "link.png").symlink_to(outside)
    assert retry_file(context, "link.png", "thumbnails") == (False, False)
    assert retry_file(context, "missing.png", "thumbnails") == (False, False)
    assert retry_file(context, "../outside.png", "thumbnails") == (False, False)
    assert context.conn().execute('SELECT count(*) FROM app.thumbnails').fetchone()[0] == 0


def test_retry_inventory_and_busy_admission(context, monkeypatch: pytest.MonkeyPatch):
    import fdrive_indexer.failure_retry as module

    source = Path(context.abs_path) / "fixed.png"
    _write_png(source)
    failures.report(context, source.name, "thumbnails", print, "DecodeError: previously broken")
    monkeypatch.setattr(module.threading, "Thread", _SyncThread)
    job = ThumbnailRebuildJob()
    assert job.try_start(0)
    assert not start_retry(job, [context], "thumbnails", None)
    job.finish()
    assert start_retry(job, [context], "thumbnails", None)
    assert job.snapshot()["processed"] == 1
    assert job.snapshot()["outcome"] == "completed"
    assert records(context.conn())[0][4] is not None


def test_retention_preserves_unresolved_and_resolves_deleted(context):
    failures.report(context, "open.png", "thumbnails", print, "DecodeError: open")
    failures.report(context, "old.png", "thumbnails", print, "DecodeError: old")
    context.conn().execute("UPDATE idx.processing_failures SET resolved_at = now() - interval '31 days' WHERE path = 'old.png'")
    failures.prune(context.conn())
    assert [r[1] for r in records(context.conn())] == ["open.png"]
    db.upsert_file(context.conn(), context.root_id, "open.png", "open.png", ".png", 1, 1, "a" * 64, None)
    db.mark_deleted(context.conn(), context.root_id, "open.png", False)
    failures.prune(context.conn())
    assert records(context.conn())[0][4] is not None


def test_ffmpeg_cause_and_attempt_isolation():
    error = subprocess.CalledProcessError(1, "ffmpeg", stderr=b"Invalid data found when processing input")
    assert "Invalid data" in failures.describe(error)
    with failures.attempt({"thumbnails": "outer"}) as outer:
        with failures.attempt() as inner:
            assert outer is inner
    with failures.attempt() as another:
        assert another is not outer


def test_semantic_retry_keeps_changed_and_missing_sources_unresolved(context, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import indexer

    context.features = FeatureConfiguration(2, FeatureValues(False, True, False, True, False, False))
    source = Path(context.abs_path) / "words.txt"
    source.write_text("original")
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    file_id = _upsert_media_file(context, source.name, ".txt", source, sha)
    db.insert_chunks(context.conn(), file_id, ["original"], [None])
    failures.report(context, source.name, "semanticSearch", print, "ValueError: rejected")
    source.write_text("changed")
    assert retry_file(context, source.name, "semanticSearch") == (False, False)
    assert records(context.conn())[0][4] is None
    source.unlink()
    assert retry_file(context, source.name, "semanticSearch") == (False, False)
    source.write_text("original")
    monkeypatch.setattr(indexer, "embed_passages", lambda *_a: [[0.1] * 384])
    assert retry_file(context, source.name, "semanticSearch") == (True, False)
    assert records(context.conn())[0][4] is not None


def test_failure_recording_does_not_abort_owning_transaction(context):
    messages: list[str] = []
    with context.conn().transaction():
        context.conn().execute('ALTER TABLE idx.processing_failures RENAME TO temporarily_unavailable')
        failures.report(context, "bad.png", "thumbnails", messages.append, "DecodeError: corrupt")
        assert context.conn().execute('SELECT 1').fetchone() == (1,)
        context.conn().execute('ALTER TABLE idx.temporarily_unavailable RENAME TO processing_failures')
    assert "DecodeError: corrupt" in messages[0]


def test_diagnostic_logs_reopen_and_rotate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import diagnostic_log as module

    monkeypatch.setenv("INDEXER_LOG_DIR", str(tmp_path))
    monkeypatch.setattr(module, "_handler", None)
    monkeypatch.setattr(module, "_configured", False)
    try:
        module.log("before restart")
        module._handler.close()
        module._handler = None
        module._configured = False
        module.log("after restart")
        assert "before restart" in (tmp_path / "indexer.log").read_text()
        assert "after restart" in (tmp_path / "indexer.log").read_text()
        module._handler.maxBytes = 100
        for i in range(20):
            module.log(f"bounded diagnostic record {i}")
        assert len(list(tmp_path.glob("indexer.log*"))) == 5
        assert "record 19" in (tmp_path / "indexer.log").read_text()
    finally:
        if module._handler:
            module._handler.close()


def test_retry_http_validation_disabled_missing_and_busy(context, monkeypatch: pytest.MonkeyPatch):
    from test_server import _make_client

    from fdrive_indexer import failure_retry

    client = _make_client(context)
    for body in ({}, {"feature": "unknown"}, {"feature": "thumbnails", "id": True}):
        assert client.post("/failures/retry", json=body).status_code == 400
    assert client.post("/failures/retry", content="{").status_code == 400
    assert client.post("/failures/retry", json={"feature": "semanticSearch"}).status_code == 409
    assert client.post("/failures/retry", json={"feature": "thumbnails", "id": 9999}).status_code == 404
    job = client.app.state.server_state.thumbnail_job
    assert job.try_start(0)
    assert client.post("/failures/retry", json={"feature": "thumbnails"}).status_code == 409
    job.finish()
    monkeypatch.setattr(failure_retry.threading, "Thread", _SyncThread)
    response = client.post("/failures/retry", json={"feature": "thumbnails"})
    assert response.status_code == 202
    assert response.json()["operationId"]


def test_first_backend_outage_is_waiting_not_a_file_failure(context, monkeypatch: pytest.MonkeyPatch):
    import httpx

    from fdrive_indexer import indexer

    context.features = FeatureConfiguration(2, FeatureValues(False, True, False, True, False, False))
    source = Path(context.abs_path) / "words.txt"
    source.write_text("searchable words")
    monkeypatch.setattr(context.extractor, "extract", lambda *a, **k: ("searchable words", "indexed"))
    def unavailable(*args):
        raise httpx.ConnectError("backend offline")
    monkeypatch.setattr(indexer, "embed_passages", unavailable)
    assert scan_once(context)["errors"] == 0
    assert records(context.conn()) == []
    snapshot = {s["features"][0]: s for s in context.activity.snapshot()}
    assert snapshot["semanticSearch"]["errors"] == 0
    assert snapshot["semanticSearch"]["skipped"] == 1


def test_retry_error_counts_once_and_releases_admission_after_start_failure(context, monkeypatch: pytest.MonkeyPatch):
    import fdrive_indexer.failure_retry as module

    monkeypatch.setattr(module.threading, "Thread", _SyncThread)
    failures.report(context, "missing.png", "thumbnails", print, "FileNotFoundError: missing")
    job = ThumbnailRebuildJob()
    assert start_retry(job, [context], "thumbnails", None)
    assert job.snapshot()["errors"] == 1
    assert records(context.conn())[0][3] == 2
    def cannot_start(*args, **kwargs):
        raise RuntimeError("cannot start thread")
    monkeypatch.setattr(module.threading, "Thread", cannot_start)
    with pytest.raises(RuntimeError, match="cannot start thread"):
        start_retry(job, [context], "thumbnails", None)
    assert job.try_start(0)
    job.finish()


def test_resolved_history_cap_never_discards_unresolved(context):
    context.conn().execute(
        "INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id, resolved_at) "
        "SELECT %s, 'resolved-' || n, 'thumbnails', 'Error', 'old error', 'old-scan', now() "
        "FROM generate_series(1, 10001) n", (context.root_id,)
    )
    failures.report(context, "still-broken.png", "thumbnails", print, "Error: unresolved")
    failures.prune(context.conn())
    assert context.conn().execute(
        'SELECT count(*) FROM idx.processing_failures WHERE resolved_at IS NOT NULL'
    ).fetchone() == (10000,)
    assert context.conn().execute(
        'SELECT path FROM idx.processing_failures WHERE resolved_at IS NULL'
    ).fetchone() == ("still-broken.png",)


def test_text_retry_repairs_chunks_without_running_other_features(context, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import indexer

    context.features = FeatureConfiguration(2, FeatureValues(True, True, False, True, True, False))
    source = Path(context.abs_path) / "repaired.txt"
    source.write_text("recovered text")
    failures.report(context, source.name, "textSearch", print, "DecodeError: could not read")
    monkeypatch.setattr(context.extractor, "extract", lambda *a, **k: ("recovered text", "indexed"))
    monkeypatch.setattr(indexer, "process_thumbnails", lambda *a, **k: pytest.fail("text retry must not generate media"))
    monkeypatch.setattr(indexer, "embed_passages", lambda *a, **k: pytest.fail("text retry must not embed"))
    assert retry_file(context, source.name, "textSearch") == (True, False)
    assert records(context.conn())[0][4] is not None
    assert context.conn().execute('SELECT text FROM idx.chunks').fetchone() == ("recovered text",)


def test_image_retry_resolves_only_its_own_feature(context, monkeypatch: pytest.MonkeyPatch):
    from fdrive_indexer import indexer

    source = Path(context.abs_path) / "photo.png"
    _write_png(source)
    for feature in ("thumbnails", "imageSearch"):
        failures.report(context, source.name, feature, print, "Error: earlier attempt")
    monkeypatch.setattr(indexer, "embed_thumbnail", lambda *a, **k: True)
    assert retry_file(context, source.name, "imageSearch") == (True, False)
    rows = records(context.conn())
    assert rows[0][4] is None
    assert rows[1][4] is not None


def test_startup_waits_for_failure_history_migration(context):
    conn = context.conn()
    logs: list[str] = []
    conn.execute('ALTER TABLE idx.processing_failures RENAME TO migration_pending')
    try:
        assert db.wait_for_schema_version(
            conn, 1, 10, logs.append,
            sleep=lambda _: conn.execute('ALTER TABLE idx.migration_pending RENAME TO processing_failures'),
        ) == 1
        assert any("processing_failures migration" in message for message in logs)
    finally:
        if conn.execute("SELECT to_regclass('idx.migration_pending')").fetchone()[0] is not None:
            conn.execute('ALTER TABLE idx.migration_pending RENAME TO processing_failures')


def test_unavailable_root_still_marks_its_scan_failed(context):
    Path(context.abs_path).rmdir()
    assert scan_once(context)["errors"] == 1
    assert context.activity.snapshot()[0]["state"] == "failed"
