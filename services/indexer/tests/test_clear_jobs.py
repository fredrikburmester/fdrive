from __future__ import annotations

import threading
from pathlib import Path

import pytest
from test_server import _make_client, _make_ctx
from test_thumb_rebuild import _SyncThread

from fdrive_indexer import clear_jobs, db, indexer, server, thumb_rebuild


def test_index_scope_preserves_other_data(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    other = _make_ctx(postgres_dsn, monkeypatch, "two", str(tmp_path))
    paths = ["dir_%", "dir_%/a", "dir_Z/a", "dir_%extra/a", "keep"]
    for path in paths:
        fid = db.upsert_file(ctx.conn(), ctx.root_id, path, path, ".txt", 1, 1, "sha", None)
        db.insert_chunks(ctx.conn(), fid, ["hello"], [[0.1] * 384])
    db.upsert_file(other.conn(), other.root_id, "dir_%/a", "a", ".txt", 1, 1, "sha", None)
    db.upsert_thumbnail(ctx.conn(), "sha", 256, "sh/sha.webp", 1, 1)
    db.start_scan(ctx.conn(), ctx.root_id)
    db.insert_moves(ctx.conn(), ctx.root_id, "old", "new", "test")
    indexer.emit_event(ctx, "created", "keep")
    (tmp_path / "original").write_text("safe")
    with ctx.conn().cursor() as cur:
        cur.execute("INSERT INTO app.accounts DEFAULT VALUES RETURNING id")
        account = cur.fetchone()[0]
        cur.execute("INSERT INTO app.providers(type, base_url) VALUES ('sftpgo', 'http://clear.test') RETURNING id")
        provider = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO app.identities(account_id, provider_id, external_username) VALUES (%s, %s, 'one') RETURNING id",
            (account, provider),
        )
        identity = cur.fetchone()[0]
        cur.execute("INSERT INTO app.tags(account_id, name, color) VALUES (%s, 'Keep', 'blue') RETURNING id", (account,))
        tag = cur.fetchone()[0]
        cur.execute("INSERT INTO app.file_tags(identity_id, path, tag_id) VALUES (%s, 'dir_%%/a', %s)", (identity, tag))
        cur.execute("INSERT INTO app.favorites(identity_id, path) VALUES (%s, 'dir_%%/a')", (identity,))
        cur.execute("INSERT INTO app.recents(identity_id, path) VALUES (%s, 'dir_%%/a')", (identity,))
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_index([ctx], "dir_%", job)
    assert set(db.get_manifest(ctx.conn(), ctx.root_id)) == set(paths[2:])
    assert len(db.get_manifest(other.conn(), other.root_id)) == 1
    assert db.thumbnails_count(ctx.conn()) == 1
    with ctx.conn().cursor() as cur:
        for table, expected in [("idx.chunks", 3), ("idx.roots", 2), ("idx.scans", 1), ("idx.moves", 1), ("idx.events", 1)]:
            cur.execute(f"SELECT count(*) FROM {table}")
            assert cur.fetchone()[0] == expected
    assert (tmp_path / "original").read_text() == "safe"
    with ctx.conn().cursor() as cur:
        for table in ["file_tags", "favorites", "recents"]:
            cur.execute(f"SELECT path FROM app.{table} WHERE identity_id = %s", (identity,))
            assert cur.fetchall() == [("dir_%/a",)]
        cur.execute("SELECT name, color FROM app.tags WHERE id = %s", (tag,))
        assert cur.fetchone() == ("Keep", "blue")
        cur.execute("DELETE FROM app.accounts WHERE id = %s", (account,))
        cur.execute("DELETE FROM app.providers WHERE id = %s", (provider,))
    assert job.snapshot()["processed"] == 2


def test_index_batches_error_and_exact_file(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    monkeypatch.setattr(clear_jobs, "BATCH_SIZE", 1)
    for path in ["one", "two", "three"]:
        db.upsert_file(ctx.conn(), ctx.root_id, path, path, ".txt", 1, 1, "sha", None)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_index([ctx], "two", job)
    assert set(db.get_manifest(ctx.conn(), ctx.root_id)) == {"one", "three"}
    get_lock = ctx.path_locks.get

    def fail_one(path):
        if path == "one":
            raise RuntimeError("locked")
        return get_lock(path)

    monkeypatch.setattr(ctx.path_locks, "get", fail_one)
    clear_jobs.clear_index([ctx], None, job)
    assert set(db.get_manifest(ctx.conn(), ctx.root_id)) == {"one"}
    assert job.snapshot()["errors"] == 1
    assert job.snapshot()["processed"] == job.snapshot()["total"] == 3


def test_clear_waits_for_extraction_and_embedding_lock(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    path = tmp_path / "file.txt"
    path.write_text("hello")
    entered, release = threading.Event(), threading.Event()
    original = indexer._process_file

    def blocking_process(*args):
        entered.set()
        assert release.wait(5)
        original(*args)

    monkeypatch.setattr(indexer, "_process_file", blocking_process)
    monkeypatch.setattr(indexer, "embed_passages", lambda *a: [[0.1] * 384])
    db.upsert_file(ctx.conn(), ctx.root_id, path.name, path.name, ".txt", 1, 1, "sha", None)
    writer = threading.Thread(target=indexer.process_file, args=(ctx, str(path), path.name, path.stat()))
    writer.start()
    assert entered.wait(5)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clearer = threading.Thread(target=clear_jobs.clear_index, args=([ctx], None, job))
    clearer.start()
    assert clearer.is_alive()
    release.set()
    writer.join(5)
    clearer.join(5)
    assert not clearer.is_alive()
    assert not db.get_manifest(ctx.conn(), ctx.root_id)
    # Embedding retries must also wait for the exact same path lock.
    with ctx.path_locks.get(path.name):
        entered.clear()

        def chunks(*args):
            entered.set()
            return []

        monkeypatch.setattr(db, "chunks_missing_embeddings", chunks)
        embedder = threading.Thread(target=indexer.embed_missing, args=(ctx, path.name))
        embedder.start()
        assert not entered.wait(0.05)
    embedder.join(5)
    assert entered.is_set()


def test_cache_manifest_orphans_failures_retry_and_preservation(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    cache = Path(ctx.cfg.thumbs_dir)
    (cache / "ab").mkdir(parents=True)
    recognized = "ab/" + "ab" * 32 + ".256.webp"
    orphan = "ab/" + "ab" * 32 + ".1024.webp"
    for rel in [recognized, orphan, "ab/keep.txt", "ab/not-a-hash.256.webp"]:
        (cache / rel).write_text("preview")
    original = tmp_path / "original"
    original.write_text("safe")
    (cache / "symlink").symlink_to(original)
    db.upsert_thumbnail(ctx.conn(), "live", 256, recognized, 1, 1)
    db.upsert_thumbnail(ctx.conn(), "gone", 256, "missing/file.webp", 1, 1)
    db.upsert_thumbnail(ctx.conn(), "bad", 256, "symlink", 1, 1)
    db.upsert_file(ctx.conn(), ctx.root_id, "original", "original", ".txt", 1, 1, "sha", None)
    job = thumb_rebuild.ThumbnailRebuildJob()
    monkeypatch.setattr(clear_jobs, "BATCH_SIZE", 1)
    clear_jobs.clear_thumbnails([ctx], job)
    assert job.snapshot()["errors"] == 1
    assert job.snapshot()["processed"] == job.snapshot()["total"] == 4
    assert db.thumbnails_count(ctx.conn()) == 1
    assert not (cache / recognized).exists() and not (cache / orphan).exists()
    assert (cache / "ab/keep.txt").exists()
    assert (cache / "ab/not-a-hash.256.webp").exists()
    assert original.read_text() == "safe"
    assert "original" in db.get_manifest(ctx.conn(), ctx.root_id)
    (cache / "symlink").unlink()
    clear_jobs.clear_thumbnails([ctx], job)
    assert db.thumbnails_count(ctx.conn()) == 0


@pytest.mark.parametrize("relative", ["", "/etc/passwd", "../original", "a/../original", "a//b", "a\\b", "a\x00b", "./a"])
def test_remove_rejects_invalid_storage_paths(tmp_path, relative):
    with clear_jobs.directory_fd(str(tmp_path)) as fd:
        with pytest.raises(ValueError):
            clear_jobs.remove_preview(fd, relative)


def test_cache_symlinks_directories_and_missing(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "file").write_text("safe")
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "link").symlink_to(outside, target_is_directory=True)
    with clear_jobs.directory_fd(str(cache)) as fd:
        with pytest.raises(OSError):
            clear_jobs.remove_preview(fd, "link/file")
        with pytest.raises(ValueError):
            clear_jobs.remove_preview(fd, "link")
        clear_jobs.remove_preview(fd, "missing")
        (cache / "empty").mkdir()
        with pytest.raises(ValueError):
            clear_jobs.remove_preview(fd, "empty")
    with pytest.raises(OSError), clear_jobs.directory_fd(str(cache / "link")):
        pass
    assert (outside / "file").read_text() == "safe"


def test_orphan_recognition_and_failed_manifest_not_retried(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    cache = Path(ctx.cfg.thumbs_dir)
    (cache / "ab").mkdir(parents=True)
    rel = "ab/" + "ab" * 32 + ".256.webp"
    (cache / rel).write_text("preview")
    (cache / "ab" / ("cd" * 32 + ".256.webp")).write_text("wrong shard")
    db.upsert_thumbnail(ctx.conn(), "fail", 256, rel, 1, 1)
    original_remove = clear_jobs.remove_preview

    def denied(fd, path):
        raise PermissionError("read only")

    monkeypatch.setattr(clear_jobs, "remove_preview", denied)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_thumbnails([ctx], job)
    assert job.snapshot()["processed"] == job.snapshot()["errors"] == 1
    assert db.thumbnails_count(ctx.conn()) == 1
    with ctx.conn().cursor() as cur:
        cur.execute("DELETE FROM app.thumbnails")
    clear_jobs.clear_thumbnails([ctx], job)
    assert job.snapshot()["errors"] == 2  # orphan failure
    monkeypatch.setattr(clear_jobs, "remove_preview", original_remove)
    clear_jobs.clear_thumbnails([ctx], job)
    assert not (cache / rel).exists()


def test_missing_cache_and_no_contexts(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_thumbnail(ctx.conn(), "gone", 256, "aa/gone.webp", 1, 1)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_thumbnails([], job)
    assert db.thumbnails_count(ctx.conn()) == 1
    clear_jobs.clear_thumbnails([ctx], job)
    assert db.thumbnails_count(ctx.conn()) == 0
    assert job.snapshot()["processed"] == 1


def test_clear_image_embeddings_no_contexts_is_noop(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-a", [0.1] * 1024)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_image_embeddings([], job)
    assert db.image_embeddings_count(ctx.conn()) == 1


def test_clear_image_embeddings_deletes_all_rows(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-a", [0.1] * 1024)
    db.upsert_image_embedding(ctx.conn(), "sha-b", "model-a", [0.2] * 1024)
    job = thumb_rebuild.ThumbnailRebuildJob()
    monkeypatch.setattr(clear_jobs, "BATCH_SIZE", 1)
    clear_jobs.clear_image_embeddings([ctx], job)
    assert db.image_embeddings_count(ctx.conn()) == 0
    assert job.snapshot()["processed"] == job.snapshot()["total"] == 2
    assert job.snapshot()["errors"] == 0


def test_clear_image_embeddings_empty_table_is_noop(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_image_embeddings([ctx], job)
    assert job.snapshot()["processed"] == 0


def test_clear_image_embeddings_failure_reports_via_callback(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-a", [0.1] * 1024)

    def boom(conn, key):
        raise RuntimeError("delete failed")

    monkeypatch.setattr(db, "delete_image_embedding", boom)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_image_embeddings([ctx], job)
    assert job.snapshot()["errors"] == 1
    assert job.snapshot()["processed"] == 1


def test_clear_runner_failures_release_admission(monkeypatch):
    job = thumb_rebuild.ThumbnailRebuildJob()
    monkeypatch.setattr(clear_jobs.threading, "Thread", _SyncThread)

    def boom():
        raise RuntimeError("failed")

    assert clear_jobs.start_clear(job, boom)
    assert job.snapshot()["errors"] == 1
    assert not job.snapshot()["running"]
    assert clear_jobs.start_clear(job, lambda: None)
    assert job.try_start(0)
    assert not clear_jobs.start_clear(job, boom)
    job.finish()
    job.finish()
    monkeypatch.setattr(_SyncThread, "start", lambda _: boom())
    with pytest.raises(RuntimeError):
        clear_jobs.start_clear(job, lambda: None)
    assert not job.snapshot()["running"]
    assert job.snapshot()["errors"] == 1


@pytest.mark.parametrize(
    "url,payload,status",
    [
        ("/index/clear", "{", 400),
        ("/index/clear", "null", 400),
        ("/index/clear", "[]", 400),
        ("/index/clear", '{"root":null}', 400),
        ("/index/clear", '{"root":1}', 400),
        ("/index/clear", '{"root":" "}', 400),
        ("/index/clear", '{"path":"a"}', 400),
        ("/index/clear", '{"root":"one","path":""}', 400),
        ("/index/clear", '{"root":"one","path":"../a"}', 400),
        ("/index/clear", '{"root":"one","path":"a/../b"}', 400),
        ("/index/clear", '{"root":"one","path":"a\\\\b"}', 400),
        ("/index/clear", '{"root":"missing"}', 404),
        ("/index/clear", '{"extra":true}', 400),
        ("/thumbnails/clear", '{"root":"one"}', 400),
        ("/image-embeddings/clear", '{"root":"one"}', 400),
    ],
)
def test_clear_validation(postgres_dsn, monkeypatch, tmp_path, url, payload, status):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    assert _make_client(ctx).post(url, content=payload).status_code == status


@pytest.mark.parametrize(
    "url,payload",
    [
        ("/index/clear", ""),
        ("/index/clear", '{"root":"one","path":"/"}'),
        ("/index/clear", '{"root":"one","path":"/a"}'),
        ("/thumbnails/clear", "{}"),
        ("/image-embeddings/clear", "{}"),
    ],
)
def test_clear_routes_run_and_report(postgres_dsn, monkeypatch, tmp_path, url, payload):
    monkeypatch.setattr(clear_jobs.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_file(ctx.conn(), ctx.root_id, "a", "a", ".txt", 1, 1, "sha", None)
    client = _make_client(ctx)
    response = client.post(url, content=payload)
    assert response.status_code == 202 and response.json() == {"started": True}
    keys = {
        "/index/clear": "index_clear",
        "/thumbnails/clear": "thumbnail_clear",
        "/image-embeddings/clear": "image_embedding_clear",
    }
    key = keys[url]
    snapshot = client.get("/stats").json()[key]
    assert snapshot["finished_at"] is not None and not snapshot["running"]
    assert snapshot["errors"] == 0
    assert not client.app.state.server_state.wake_events["one"].is_set()
    if url == "/index/clear":
        assert not db.get_manifest(ctx.conn(), ctx.root_id)


@pytest.mark.parametrize(
    "active", ["thumbnail_job", "index_clear_job", "thumbnail_clear_job", "image_embed_rebuild_job", "image_embed_clear_job"]
)
@pytest.mark.parametrize(
    "url", ["/index/clear", "/thumbnails/clear", "/thumbnails/rebuild", "/image-embeddings/clear", "/image-embeddings/rebuild"]
)
def test_shared_admission(postgres_dsn, monkeypatch, tmp_path, active, url):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    client = _make_client(ctx)
    job = getattr(client.app.state.server_state, active)
    assert job.try_start(0)
    assert client.post(url, json={}).status_code == 409
    job.finish()


def test_start_failure_http_and_rebuild_cleanup(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    client = _make_client(ctx)

    def boom(*a, **kw):
        raise RuntimeError("cannot start")

    monkeypatch.setattr(server, "start_clear", boom)
    assert client.post("/index/clear").status_code == 500
    job = thumb_rebuild.ThumbnailRebuildJob()
    monkeypatch.setattr(thumb_rebuild.db, "media_files", boom)
    with pytest.raises(RuntimeError):
        thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert not job.snapshot()["running"] and job.snapshot()["errors"] == 1
    monkeypatch.setattr(thumb_rebuild.db, "media_files", lambda *a: [])
    monkeypatch.setattr(thumb_rebuild.threading, "Thread", boom)
    with pytest.raises(RuntimeError):
        thumb_rebuild.start_rebuild(job, [ctx], None, False)
    assert not job.snapshot()["running"] and job.snapshot()["errors"] == 1


def test_admission_returns_before_discovery_and_uses_thread_connection(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    main_conn = ctx.conn()
    entered, release = threading.Event(), threading.Event()
    seen = []

    def slow(contexts, scope, job):
        seen.append(contexts[0].conn())
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(server, "clear_index", slow)
    client = _make_client(ctx)
    response = client.post("/index/clear")
    try:
        assert response.status_code == 202
        assert entered.wait(5)
        assert seen[0] is not main_conn
        assert client.post("/thumbnails/clear").status_code == 409
    finally:
        release.set()
    job = client.app.state.server_state.index_clear_job
    for _ in range(100):
        if not job.snapshot()["running"]:
            break
        threading.Event().wait(0.01)
    assert not job.snapshot()["running"]


def test_orphan_unreadable_and_disappearing_shards_reported(tmp_path, monkeypatch):
    (tmp_path / "ab").mkdir()
    (tmp_path / "cd").mkdir()
    opened = clear_jobs.os.open

    def fail_shards(path, flags, **kwargs):
        if path == "ab":
            raise PermissionError("denied")
        if path == "cd":
            raise FileNotFoundError("gone")
        return opened(path, flags, **kwargs)

    job = thumb_rebuild.ThumbnailRebuildJob()
    with clear_jobs.directory_fd(str(tmp_path)) as fd:
        monkeypatch.setattr(clear_jobs.os, "open", fail_shards)
        assert list(clear_jobs.orphan_previews(fd, job)) == []
    assert job.snapshot()["total"] == job.snapshot()["errors"] == 1


def test_manifest_iteration_bounded_during_generation(postgres_dsn, monkeypatch, tmp_path):
    ctx = _make_ctx(postgres_dsn, monkeypatch, "one", str(tmp_path))
    db.upsert_thumbnail(ctx.conn(), "a", 256, "aa/a.webp", 1, 1)
    original = clear_jobs.remove_preview

    def generating(fd, relative):
        db.upsert_thumbnail(ctx.conn(), "z", 256, "zz/z.webp", 1, 1)
        original(fd, relative)

    monkeypatch.setattr(clear_jobs, "remove_preview", generating)
    monkeypatch.setattr(clear_jobs, "BATCH_SIZE", 1)
    job = thumb_rebuild.ThumbnailRebuildJob()
    clear_jobs.clear_thumbnails([ctx], job)
    assert job.snapshot()["processed"] == job.snapshot()["total"] == 1
    with ctx.conn().cursor() as cur:
        cur.execute("SELECT content_key FROM app.thumbnails")
        assert cur.fetchall() == [("z",)]
