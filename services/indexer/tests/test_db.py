"""I/O tests for db.py against a real Postgres with the repo's own migrations
applied (see conftest.py). Each test starts from empty tables.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from fdrive_indexer import db
from fdrive_indexer.events import build_event


def test_connect_success(postgres_dsn: str) -> None:
    conn = db.connect(postgres_dsn)
    try:
        assert db.read_schema_version(conn) == 1
    finally:
        conn.close()


def test_connect_retries_then_raises() -> None:
    sleeps: list[float] = []
    with pytest.raises(RuntimeError, match="could not connect to postgres"):
        db.connect("postgresql://bad-host-that-does-not-exist:5432/nope", retries=2, sleep=sleeps.append)
    assert len(sleeps) == 2


def test_upsert_root_idempotent(db_conn: psycopg.Connection) -> None:
    first = db.upsert_root(db_conn, "sftpgo")
    second = db.upsert_root(db_conn, "sftpgo")
    assert first == second


def test_upsert_root_distinct_names(db_conn: psycopg.Connection) -> None:
    a = db.upsert_root(db_conn, "sftpgo")
    b = db.upsert_root(db_conn, "photos")
    assert a != b


def test_read_schema_version_matches_migration(db_conn: psycopg.Connection) -> None:
    assert db.read_schema_version(db_conn) == 1


class _BrokenCursor:
    def __enter__(self) -> _BrokenCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, *args: object, **kwargs: object) -> None:
        raise psycopg.errors.UndefinedTable("boom")


class _BrokenConn:
    def cursor(self) -> _BrokenCursor:
        return _BrokenCursor()

    def rollback(self) -> None:
        self.rolled_back = True


def test_read_schema_version_returns_none_on_db_error() -> None:
    conn = _BrokenConn()
    assert db.read_schema_version(conn) is None  # type: ignore[arg-type]
    assert conn.rolled_back is True


def test_wait_for_schema_version_success_first_try(db_conn: psycopg.Connection) -> None:
    logs: list[str] = []
    result = db.wait_for_schema_version(db_conn, expected=1, timeout_seconds=10, log=logs.append, sleep=lambda _s: None)
    assert result == 1
    assert logs == []


def test_wait_for_schema_version_times_out() -> None:
    logs: list[str] = []
    clock = iter([0.0, 0.0, 100.0])  # first call under deadline, second call over it

    class NeverReady:
        def cursor(self) -> _BrokenCursor:
            return _BrokenCursor()

        def rollback(self) -> None:
            pass

    result = db.wait_for_schema_version(
        NeverReady(),  # type: ignore[arg-type]
        expected=1,
        timeout_seconds=1,
        log=logs.append,
        sleep=lambda _s: None,
        now=lambda: next(clock),
    )
    assert result is None
    assert any("giving up" in line for line in logs)


def test_upsert_file_and_get_manifest(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    file_id = db.upsert_file(db_conn, root_id, "a/b.txt", "b.txt", ".txt", 10, 123, "sha1", "text/plain")
    assert file_id > 0
    manifest = db.get_manifest(db_conn, root_id)
    assert manifest["a/b.txt"] == (10, 123, "pending", None)


def test_upsert_file_conflict_updates_row(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    existing_id = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    db.update_file_status(db_conn, existing_id, "indexed", 5, None)
    file_id = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 20, 2, "sha2", "text/plain")
    manifest = db.get_manifest(db_conn, root_id)
    assert manifest["a.txt"] == (20, 2, "pending", None)
    # chunks from the previous version are cleared on re-upsert
    assert db.chunks_missing_embeddings(db_conn, root_id, "a.txt") == []
    assert file_id > 0


def test_insert_chunks_and_missing_embeddings(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    file_id = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    db.insert_chunks(db_conn, file_id, ["hello", "world"], [None, None])
    missing = db.chunks_missing_embeddings(db_conn, root_id, "a.txt")
    assert [text for _, text in missing] == ["hello", "world"]
    db.set_chunk_embeddings(db_conn, [(cid, [0.1] * 384) for cid, _ in missing])
    assert db.chunks_missing_embeddings(db_conn, root_id, "a.txt") == []


def test_insert_chunks_empty_is_noop(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    file_id = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    db.insert_chunks(db_conn, file_id, [], [])  # should not raise


def test_set_chunk_embeddings_empty_is_noop(db_conn: psycopg.Connection) -> None:
    db.set_chunk_embeddings(db_conn, [])  # should not raise


def test_mark_file_indexed_and_error(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    db.mark_file_indexed(db_conn, root_id, "a.txt")
    assert db.get_manifest(db_conn, root_id)["a.txt"][2] == "indexed"
    db.mark_file_error(db_conn, root_id, "a.txt", "boom")
    assert db.get_manifest(db_conn, root_id)["a.txt"][2] == "error"


def test_mark_deleted_single_file(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 10, 1, "sha1", "text/plain")
    ids = db.mark_deleted(db_conn, root_id, "a.txt", is_dir=False)
    assert len(ids) == 1
    # soft-deleted rows stay in the manifest (deleted_at set) so a reappearing path
    # is recognised as changed rather than brand new
    assert db.get_manifest(db_conn, root_id)["a.txt"][3] is not None


def test_mark_deleted_no_matching_rows_is_noop(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    ids = db.mark_deleted(db_conn, root_id, "never-existed.txt", is_dir=False)
    assert ids == []


def test_mark_deleted_subtree(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "dir/a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.upsert_file(db_conn, root_id, "dir/b.txt", "b.txt", ".txt", 1, 1, "sha2", None)
    db.upsert_file(db_conn, root_id, "other.txt", "other.txt", ".txt", 1, 1, "sha3", None)
    ids = db.mark_deleted(db_conn, root_id, "dir", is_dir=True)
    assert len(ids) == 2
    manifest = db.get_manifest(db_conn, root_id)
    assert manifest["dir/a.txt"][3] is not None
    assert manifest["dir/b.txt"][3] is not None
    assert manifest["other.txt"][3] is None


def test_rename_file(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "old.txt", "old.txt", ".txt", 1, 1, "sha1", None)
    moved = db.rename_paths(db_conn, root_id, "old.txt", "new.txt", is_dir=False)
    assert moved == 1
    assert set(db.get_manifest(db_conn, root_id)) == {"new.txt"}


def test_rename_file_overwrites_stale_destination(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "old.txt", "old.txt", ".txt", 1, 1, "sha1", None)
    dst_id = db.upsert_file(db_conn, root_id, "new.txt", "new.txt", ".txt", 1, 1, "sha2", None)
    db.mark_deleted(db_conn, root_id, "new.txt", is_dir=False)
    # re-insert a stale (deleted) row at the destination path directly to simulate
    # a delete that has not been swept yet
    with db_conn.cursor() as cur:
        cur.execute('SELECT deleted_at FROM "idx"."files" WHERE id = %s', (dst_id,))
        assert cur.fetchone()[0] is not None
    moved = db.rename_paths(db_conn, root_id, "old.txt", "new.txt", is_dir=False)
    assert moved == 1
    manifest = db.get_manifest(db_conn, root_id)
    assert set(manifest) == {"new.txt"}


def test_rename_dir(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "dir/a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.upsert_file(db_conn, root_id, "dir/sub/b.txt", "b.txt", ".txt", 1, 1, "sha2", None)
    moved = db.rename_paths(db_conn, root_id, "dir", "moved", is_dir=True)
    assert moved == 2
    assert set(db.get_manifest(db_conn, root_id)) == {"moved/a.txt", "moved/sub/b.txt"}


def test_insert_moves(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.insert_moves(db_conn, root_id, "old.txt", "new.txt", "watcher")
    with db_conn.cursor() as cur:
        cur.execute('SELECT src, dst, actor FROM "idx"."moves" WHERE root_id = %s', (root_id,))
        assert cur.fetchall() == [("old.txt", "new.txt", "watcher")]


def test_record_event_inserts_row(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    event = build_event("created", "sftpgo", "a.txt")
    db.record_event(db_conn, root_id, event)
    with db_conn.cursor() as cur:
        cur.execute('SELECT kind, path, target_path FROM "idx"."events" WHERE root_id = %s', (root_id,))
        assert cur.fetchall() == [("created", "a.txt", None)]


def test_prune_events_removes_old_rows(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    old = datetime.now(UTC) - timedelta(days=30)
    with db_conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "idx"."events" (at, root_id, kind, path) VALUES (%s, %s, %s, %s)',
            (old, root_id, "created", "old.txt"),
        )
    db.record_event(db_conn, root_id, build_event("created", "sftpgo", "new.txt"))
    removed = db.prune_events(db_conn, older_than_days=7)
    assert removed == 1
    with db_conn.cursor() as cur:
        cur.execute('SELECT path FROM "idx"."events" WHERE root_id = %s', (root_id,))
        assert cur.fetchall() == [("new.txt",)]


def test_scan_lifecycle(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    scan_id, started_at = db.start_scan(db_conn, root_id)
    assert scan_id > 0
    assert started_at is not None
    db.finish_scan(db_conn, scan_id, seen=5, changed=2, deleted=1, errors=0)
    stats = db.root_stats(db_conn, "sftpgo", root_id)
    assert stats.last_scan is not None
    assert stats.last_scan["files_seen"] == 5


def test_sweep_vanished_marks_untouched_rows_deleted(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "kept.txt", "kept.txt", ".txt", 1, 1, "sha1", None)
    db.upsert_file(db_conn, root_id, "vanished.txt", "vanished.txt", ".txt", 1, 1, "sha2", None)
    _scan_id, started_at = db.start_scan(db_conn, root_id)
    deleted = db.sweep_vanished(db_conn, root_id, ["kept.txt"], started_at)
    assert deleted == 1
    manifest = db.get_manifest(db_conn, root_id)
    assert manifest["kept.txt"][3] is None
    assert manifest["vanished.txt"][3] is not None


def test_read_settings(db_conn: psycopg.Connection) -> None:
    with db_conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            ("indexer.workers", psycopg.types.json.Json(8)),
        )
    settings = db.read_settings(db_conn)
    assert settings["indexer.workers"] == 8


def test_upsert_thumbnail_and_count(db_conn: psycopg.Connection) -> None:
    db.upsert_thumbnail(db_conn, "sha1", 256, "sh/sha1.256.webp", 256, 128)
    assert db.thumbnails_count(db_conn) == 1
    db.upsert_thumbnail(db_conn, "sha1", 256, "sh/sha1.256.webp", 300, 150)
    assert db.thumbnails_count(db_conn) == 1
    with db_conn.cursor() as cur:
        cur.execute('SELECT width, height FROM "app"."thumbnails" WHERE content_key = %s', ("sha1",))
        assert cur.fetchone() == (300, 150)


def test_media_files_excludes_deleted(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    db.upsert_file(db_conn, root_id, "a.png", "a.png", ".png", 100, 1, "sha1", "image/png")
    db.upsert_file(db_conn, root_id, "b.pdf", "b.pdf", ".pdf", 200, 1, "sha2", "application/pdf")
    db.mark_deleted(db_conn, root_id, "b.pdf", False)
    rows = db.media_files(db_conn, root_id)
    assert rows == [("a.png", ".png", "sha1", 100)]


def test_media_files_empty_root(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    assert db.media_files(db_conn, root_id) == []


def test_root_stats_counts_and_chunks(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    f1 = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(db_conn, f1, "indexed", 10, None)
    db.insert_chunks(db_conn, f1, ["hello"], [[0.1] * 384])
    f2 = db.upsert_file(db_conn, root_id, "b.txt", "b.txt", ".txt", 1, 1, "sha2", None)
    db.update_file_status(db_conn, f2, "error", 0, "boom")
    stats = db.root_stats(db_conn, "sftpgo", root_id)
    assert stats.counts_by_status == {"indexed": 1, "error": 1}
    assert stats.chunks == 1
    assert stats.chunks_embedded == 1
    assert stats.last_scan is None


def test_errors_sample(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    f1 = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(db_conn, f1, "error", 0, "boom")
    sample = db.errors_sample(db_conn, root_id)
    assert sample == [{"path": "a.txt", "error": "boom"}]


def test_mark_pending_whole_root(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    f1 = db.upsert_file(db_conn, root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(db_conn, f1, "indexed", 10, None)
    count = db.mark_pending(db_conn, root_id, None, None)
    assert count == 1
    assert db.get_manifest(db_conn, root_id)["a.txt"][2] == "pending"


def test_mark_pending_subtree(db_conn: psycopg.Connection) -> None:
    root_id = db.upsert_root(db_conn, "sftpgo")
    f1 = db.upsert_file(db_conn, root_id, "dir/a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    f2 = db.upsert_file(db_conn, root_id, "other.txt", "other.txt", ".txt", 1, 1, "sha2", None)
    db.update_file_status(db_conn, f1, "indexed", 1, None)
    db.update_file_status(db_conn, f2, "indexed", 1, None)
    exact, prefix = "dir", "dir/"
    count = db.mark_pending(db_conn, root_id, exact, prefix)
    manifest = db.get_manifest(db_conn, root_id)
    assert count == 1
    assert manifest["dir/a.txt"][2] == "pending"
    assert manifest["other.txt"][2] == "indexed"
