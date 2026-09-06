from __future__ import annotations

import threading
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from fdrive_indexer import db, server
from fdrive_indexer.chunking import normalize
from fdrive_indexer.config import Config
from fdrive_indexer.extract import Extractor
from fdrive_indexer.indexer import RootContext


def _make_ctx(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, root: str, abs_path: str) -> RootContext:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.setenv("INDEX_ROOTS", f"{root}={abs_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
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


def test_stats_reports_counts(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)
    db.insert_chunks(ctx.conn(), file_id, ["hello"], [[0.1] * 384])
    db.upsert_thumbnail(ctx.conn(), "sha1", 256, "sh/sha1.256.webp", 100, 50)
    client = _make_client(ctx)
    resp = client.get("/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["roots"][0]["root"] == "sftpgo"
    assert body["roots"][0]["counts_by_status"] == {"indexed": 1}
    assert body["thumbnails"] == 1
    assert body["queue_depth"] == 0


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


def test_thumbnails_rebuild_without_wake_event_registered(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    state = server.ServerState(
        contexts={ctx.name: ctx}, watchers={}, wake_events={}, conn_factory=ctx.conn, schema_version=lambda: 1
    )
    client = TestClient(server.create_app(state))
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo"})
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


def test_thumbnails_rebuild_specific_root(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "sftpgo"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}


def test_thumbnails_rebuild_all_roots_no_body(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    file_id = db.upsert_file(ctx.conn(), ctx.root_id, "a.txt", "a.txt", ".txt", 1, 1, "sha1", None)
    db.update_file_status(ctx.conn(), file_id, "indexed", 5, None)
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild")
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}


def test_thumbnails_rebuild_unknown_root_is_ignored(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _make_ctx(postgres_dsn, monkeypatch, "sftpgo", str(tmp_path))
    client = _make_client(ctx)
    resp = client.post("/thumbnails/rebuild", json={"root": "unknown"})
    assert resp.json() == {"count": 0}
