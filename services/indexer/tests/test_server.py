from __future__ import annotations

import os
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from fdrive_indexer import db, server
from fdrive_indexer import thumb_rebuild as thumb_rebuild_module
from fdrive_indexer.chunking import normalize
from fdrive_indexer.config import Config
from fdrive_indexer.extract import Extractor
from fdrive_indexer.indexer import RootContext


class _SyncThread:
    """Runs the rebuild synchronously so tests do not need to poll a background
    thread for completion."""

    def __init__(self, target: object, daemon: bool = True, name: str | None = None) -> None:
        self._target = target

    def start(self) -> None:
        self._target()  # type: ignore[operator]


def _write_png(path: Path) -> None:
    from PIL import Image

    Image.new("RGB", (200, 100), color="red").save(path)


def _make_ctx(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, root: str, abs_path: str) -> RootContext:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.setenv("INDEX_ROOTS", f"{root}={abs_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    monkeypatch.setenv("THUMBS_DIR", os.path.join(abs_path, "_thumbs_test"))
    cfg = Config()
    conn = db.connect(postgres_dsn)
    root_id = db.upsert_root(conn, root)
    settings = cfg.default_settings()
    extractor = Extractor(
        root=root,
        text_max_bytes=cfg.text_max_bytes,
        image_max_bytes=cfg.image_max_bytes,
        max_pdf_pages=cfg.max_pdf_pages,
        plain_text_cap=cfg.plain_text_cap,
        tesseract_langs=settings.tesseract_langs,
        ocr_image_globs=list(settings.ocr_image_globs),
        tika_url=cfg.tika_url,
        normalize=normalize,
    )
    ctx = RootContext(name=root, root_id=root_id, abs_path=abs_path, cfg=cfg, settings=settings, extractor=extractor)
    ctx.local.conn = conn
    return ctx


def _make_client(ctx: RootContext, watcher: object | None = None, schema_version: int | None = 1) -> TestClient:
    state = server.ServerState(
        contexts={ctx.name: ctx},
        watchers={ctx.name: watcher},
        wake_events={ctx.name: threading.Event()},
        conn_factory=ctx.conn,
        schema_version=lambda: schema_version,
    )
    app = server.create_app(state)
    return TestClient(app)


def test_health_ok(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx, watcher=object())
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["roots"] == ["sftpgo"]
    assert body["watcher"] == {"sftpgo": True}
    assert body["embed_ok"] is False  # embed.invalid is unreachable
    assert body["schema_version"] == 1


def test_health_no_contexts(postgres_dsn: str) -> None:
    state = server.ServerState(contexts={}, watchers={}, wake_events={}, conn_factory=lambda: None, schema_version=lambda: None)
    client = TestClient(server.create_app(state))
    resp = client.get("/health")
    body = resp.json()
    assert body["ok"] is False
    assert body["embed_ok"] is False


def test_storage_diagnostics_reports_missing_or_readable_roots(tmp_path: Path) -> None:
    diagnostics = server.storage_diagnostics(
        {
            "mounted": SimpleNamespace(abs_path=str(tmp_path)),
            "missing": SimpleNamespace(abs_path=str(tmp_path / "missing")),
        }  # type: ignore[arg-type]
    )
    assert diagnostics["mounted"]["readable"] is True
    assert diagnostics["missing"] == {"readable": False, "writable": False}


def test_stats_reports_counts(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [[0.1] * 384])
    db.upsert_thumbnail(ctx.conn(), "sha1", 256, "sh/sha1.256.webp", 100, 50)
    db.upsert_image_embedding(ctx.conn(), "sha1", "model-a", [0.1] * 1024)
    client = _make_client(ctx)
    resp = client.get("/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["roots"][0]["root"] == "sftpgo"
    assert body["roots"][0]["counts_by_status"] == {"indexed": 1}
    assert body["thumbnails"] == 1
    assert body["image_embeddings"] == 1
    assert body["queue_depth"] == 0
    assert body["thumbnail_rebuild"] == {
        "running": False,
        "processed": 0,
        "total": 0,
        "started_at": None,
        "finished_at": None,
        "errors": 0,
    }
    assert body["image_embedding_rebuild"] == {
        "running": False,
        "processed": 0,
        "total": 0,
        "started_at": None,
        "finished_at": None,
        "errors": 0,
    }
    assert body["image_embedding_clear"] == {
        "running": False,
        "processed": 0,
        "total": 0,
        "started_at": None,
        "finished_at": None,
        "errors": 0,
    }


def test_stats_reports_running_image_embedding_rebuild(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    client.app.state.server_state.image_embed_rebuild_job.try_start(3)
    resp = client.get("/stats")
    body = resp.json()
    assert body["image_embedding_rebuild"]["running"] is True
    assert body["image_embedding_rebuild"]["total"] == 3


def test_stats_reports_running_thumbnail_rebuild(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    client.app.state.server_state.thumbnail_job.try_start(3)
    resp = client.get("/stats")
    body = resp.json()
    assert body["thumbnail_rebuild"]["running"] is True
    assert body["thumbnail_rebuild"]["total"] == 3


def test_extract_returns_text_for_known_root(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    (tmp_path / "readme.md").write_text("hello world this is a long enough markdown body")
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "readme.md"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "indexed"
    assert "hello world" in body["text"]


def test_extract_respects_offset_and_max_chars(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    (tmp_path / "readme.md").write_text("0123456789abcdefghij")
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "readme.md", "offset": 2, "max_chars": 5})
    body = resp.json()
    assert body["text"] == "23456"
    assert body["total_chars"] == 20


def test_extract_missing_root_or_path_is_400(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo"})
    assert resp.status_code == 400


def test_extract_unknown_root_is_404(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "unknown", "path": "a.txt"})
    assert resp.status_code == 404


def test_extract_path_escaping_root_is_400(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "../../etc/passwd"})
    assert resp.status_code == 400


def test_extract_missing_file_is_404(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "missing.txt"})
    assert resp.status_code == 404


def test_extract_non_textual_extension_returns_none_status(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    (tmp_path / "app.bin").write_bytes(b"x")
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "app.bin"})
    body = resp.json()
    assert body == {"text": None, "status": "none"}


def test_extract_no_text_status_returns_null_text(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    (tmp_path / "empty.txt").write_bytes(b"")
    client = _make_client(ctx)
    resp = client.post("/extract", json={"root": "sftpgo", "path": "empty.txt"})
    body = resp.json()
    assert body["text"] is None
    assert body["status"] == "empty"


def test_reindex_whole_root(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)
    event = threading.Event()
    state = server.ServerState(
        contexts={ctx.name: ctx},
        watchers={ctx.name: None},
        wake_events={ctx.name: event},
        conn_factory=ctx.conn,
        schema_version=lambda: 1,
    )
    client = TestClient(server.create_app(state))
    resp = client.post("/reindex", json={"root": "sftpgo"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}
    assert event.is_set() is True


def test_reindex_subtree(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    f1 = db.upsert_file(ctx.conn(), ctx.root_id, "dir/a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    f2 = db.upsert_file(ctx.conn(), ctx.root_id, "other.txt", "other.txt", ".txt", 1, 1, "sha2", None)
    db.update_file_status(ctx.conn(), f1, "indexed", 1, None)
    db.update_file_status(ctx.conn(), f2, "indexed", 1, None)
    client = _make_client(ctx)
    resp = client.post("/reindex", json={"root": "sftpgo", "path": "dir"})
    assert resp.json() == {"count": 1}


def test_reindex_without_wake_event_registered(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    state = server.ServerState(
        contexts={ctx.name: ctx}, watchers={}, wake_events={}, conn_factory=ctx.conn, schema_version=lambda: 1
    )
    client = TestClient(server.create_app(state))
    resp = client.post("/reindex", json={"root": "sftpgo"})
    assert resp.status_code == 200


def test_reindex_missing_root_is_400(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/reindex", json={})
    assert resp.status_code == 400


def test_reindex_unknown_root_is_404(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/reindex", json={"root": "unknown"})
    assert resp.status_code == 404


def test_reindex_with_thumbnails_true_also_queues_rebuild(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(thumb_rebuild_module.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    client = _make_client(ctx)
    resp = client.post("/reindex", json={"root": "sftpgo", "thumbnails": True})
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}
    assert db.thumbnails_count(ctx.conn()) == 2


def test_reindex_without_thumbnails_flag_does_not_touch_thumbnails(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    client = _make_client(ctx)
    resp = client.post("/reindex", json={"root": "sftpgo"})
    assert resp.status_code == 200
    assert db.thumbnails_count(ctx.conn()) == 0


def test_reindex_thumbnails_true_ignored_when_rebuild_already_running(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    client.app.state.server_state.thumbnail_job.try_start(1)
    resp = client.post("/reindex", json={"root": "sftpgo", "thumbnails": True})
    assert resp.status_code == 200


def test_thumbnails_rebuild_specific_root(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(thumb_rebuild_module.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 1}
    assert db.thumbnails_count(ctx.conn()) == 2


def test_thumbnails_rebuild_all_roots_no_body(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(thumb_rebuild_module.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild")
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 1}


def test_thumbnails_rebuild_unknown_root_is_ignored(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(thumb_rebuild_module.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "unknown"})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 0}


def test_thumbnails_rebuild_force_and_path_are_forwarded(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(thumb_rebuild_module.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    (tmp_path / "keep").mkdir()
    (tmp_path / "skip").mkdir()
    keep_png, skip_png = tmp_path / "keep" / "a.png", tmp_path / "skip" / "b.png"
    _write_png(keep_png)
    _write_png(skip_png)
    for rel, p in [("keep/a.png", keep_png), ("skip/b.png", skip_png)]:
        st = p.stat()
        db.upsert_file(ctx.conn(), ctx.root_id, rel, p.name, ".png", st.st_size, st.st_mtime_ns, rel, "image/png")
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo", "path": "keep", "force": True})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 1}
    assert db.thumbnails_count(ctx.conn()) == 2


def test_thumbnails_rebuild_returns_409_when_already_running(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    client.app.state.server_state.thumbnail_job.try_start(1)
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 409


def test_thumbnails_rebuild_invalid_root_type_is_400(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": 123})
    assert resp.status_code == 400


def test_thumbnails_rebuild_invalid_path_type_is_400(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo", "path": 123})
    assert resp.status_code == 400


def test_image_embeddings_rebuild_not_configured_reports_zero(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    client = _make_client(ctx)
    resp = client.post("/image-embeddings/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 0}


def test_image_embeddings_rebuild_invalid_root_type_is_400(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/image-embeddings/rebuild", json={"root": 123})
    assert resp.status_code == 400


def test_image_embeddings_rebuild_invalid_path_type_is_400(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/image-embeddings/rebuild", json={"root": "sftpgo", "path": 123})
    assert resp.status_code == 400


def test_image_embeddings_rebuild_unknown_root_is_ignored(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/image-embeddings/rebuild", json={"root": "unknown"})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 0}


def test_image_embeddings_rebuild_returns_409_when_already_running(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    client.app.state.server_state.image_embed_rebuild_job.try_start(1)
    resp = client.post("/image-embeddings/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 409


def test_image_embeddings_rebuild_runs_end_to_end(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from fdrive_indexer import image_embed_rebuild
    from fdrive_indexer.image_embed import ImageEmbedHealth

    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", _SyncThread)
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    monkeypatch.setenv("IMAGE_EMBED_URL", "http://image-embed.invalid")
    ctx.cfg.image_embed_url = "http://image-embed.invalid"
    png = tmp_path / "a.png"
    _write_png(png)
    st = png.stat()
    db.upsert_file(ctx.conn(), ctx.root_id, "a.png", "a.png", ".png", st.st_size, st.st_mtime_ns, "sha1", "image/png")
    thumb_dir = Path(ctx.cfg.thumbs_dir) / "sh"
    thumb_dir.mkdir(parents=True, exist_ok=True)
    (thumb_dir / "sha1.256.webp").write_bytes(b"fake webp")
    health = ImageEmbedHealth(status="ok", model="model-a", dim=1024, device="cpu")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: health)
    monkeypatch.setattr(image_embed_rebuild, "embed_images", lambda data, url, batch: ([[0.1] * 1024 for _ in data], "model-a"))
    client = _make_client(ctx)
    resp = client.post("/image-embeddings/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 202
    assert resp.json() == {"started": True, "total": 1}
    assert db.image_embedding_model(ctx.conn(), "sha1") == "model-a"


def test_directory_endpoint(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    target = tmp_path / "文 space%20"
    target.mkdir()
    (target / "a.txt").touch()
    response = client.get("/directory", params={"root": "sftpgo", "path": "/文 space%20"})
    assert response.status_code == 200
    assert response.json() == {"items": [{"name": "a.txt", "kind": "file"}], "overflow": False}
    for query in [
        "",
        "root=sftpgo",
        "root=sftpgo&path=/&extra=a",
        "root=sftpgo&path=/&path=/",
        "root=sftpgo&root=sftpgo&path=/",
        "root=sftpgo&path=%2F..%2F",
        "root=sftpgo&path=%2F%2e%2e",
        "root=sftpgo&path=%2Fa%2F%2Fb",
        "root=sftpgo&path=%2Fa%5Cb",
        "root=sftpgo&path=%2F%00",
    ]:
        assert client.get("/directory?" + query).status_code == 400
    assert client.get("/directory?root=missing&path=/").status_code == 404
    assert client.get("/directory?root=sftpgo&path=/missing").status_code == 404
    assert client.get("/directory", params={"root": "sftpgo", "path": "/文 space%20/a.txt"}).status_code == 400
    (tmp_path / "link").symlink_to(target)
    assert client.get("/directory?root=sftpgo&path=/link").status_code == 400
    literal = tmp_path / "%2e%2e"
    literal.mkdir()
    assert client.get("/directory?root=sftpgo&path=/%252e%252e").status_code == 200


def test_directory_offloads_and_sanitizes_errors(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import errno

    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    for code, expected in [(errno.EACCES, 403), (errno.EPERM, 403), (errno.ELOOP, 400), (errno.EIO, 503)]:

        def fail(root: str, path: str, error_code: int = code) -> None:
            # AnyIO's worker name proves blocking I/O ran outside the async portal thread.
            assert "worker" in threading.current_thread().name.lower()
            raise OSError(error_code, str(tmp_path / "private"))

        monkeypatch.setattr(server, "list_directory", fail)
        response = client.get("/directory?root=sftpgo&path=/")
        assert response.status_code == expected
        assert response.json() == {"error": "directory unavailable"}
