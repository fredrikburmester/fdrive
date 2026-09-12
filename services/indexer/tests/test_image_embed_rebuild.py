"""Tests for image_embed_rebuild.py.

`rebuild_image_embeddings`, `count_image_embed_candidates`, and
`start_image_embed_rebuild` are I/O: they run against a real Postgres (via
conftest's testcontainers fixture) and a `tmp_path` root with real thumbnail
files on disk, mirroring test_thumb_rebuild.py's pattern. The sidecar itself
is always a fake: no test reaches a real image-embed HTTP endpoint.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fdrive_indexer import db, image_embed_rebuild
from fdrive_indexer.config import Config
from fdrive_indexer.features import FeatureConfiguration, FeatureValues
from fdrive_indexer.image_embed import ImageEmbedHealth
from fdrive_indexer.indexer import RootContext
from fdrive_indexer.thumbs import storage_path

_HEALTHY = ImageEmbedHealth(status="ok", model="model-a", dim=1024, device="cpu")


class _StubExtractor:
    def extract(self, abs_path: str, rel_path: str, ext: str, size: int) -> tuple[str | None, str]:
        return None, "none"


class _SyncThread:
    """Runs `target` synchronously on `.start()` so background-job tests do not
    need to poll or sleep."""

    def __init__(self, target: object, daemon: bool = True, name: str | None = None) -> None:
        self._target = target

    def start(self) -> None:
        self._target()  # type: ignore[operator]


def _make_config(
    monkeypatch: pytest.MonkeyPatch, database_url: str, thumbs_dir: str, image_embed_url: str = "http://image-embed.invalid"
) -> Config:
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("INDEX_ROOTS", "sftpgo=/unused")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    monkeypatch.setenv("THUMBS_DIR", thumbs_dir)
    if image_embed_url:
        monkeypatch.setenv("IMAGE_EMBED_URL", image_embed_url)
    else:
        monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)
    return Config()


def _make_context(cfg: Config, root: str, abs_path: str) -> RootContext:
    conn = db.connect(cfg.database_url)
    root_id = db.upsert_root(conn, root)
    settings = cfg.default_settings()
    ctx = RootContext(
        name=root,
        root_id=root_id,
        abs_path=abs_path,
        cfg=cfg,
        settings=settings,
        extractor=_StubExtractor(),  # type: ignore[arg-type]
        features=FeatureConfiguration(0, FeatureValues(True, True, True, True, True, True)),
    )
    ctx.local.conn = conn
    return ctx


def _upsert_image_file(ctx: RootContext, rel_path: str, sha256: str) -> int:
    return db.upsert_file(ctx.conn(), ctx.root_id, rel_path, rel_path.rsplit("/", 1)[-1], ".png", 100, 1, sha256, "image/png")


def _write_thumb(cfg: Config, sha256: str) -> None:
    dest = Path(cfg.thumbs_dir) / storage_path(sha256, 256)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"fake webp bytes")


# -- rebuild_image_embeddings ---------------------------------------------------------------


def test_rebuild_not_configured_is_noop(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"), image_embed_url="")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 0


def test_rebuild_skips_when_dimension_guard_fails(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: None)
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 0
    assert db.image_embeddings_count(ctx.conn()) == 0


def test_rebuild_embeds_missing_candidates(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(
        image_embed_rebuild, "embed_images", lambda data, url, batch: ([[0.1] * 1024 for _ in data], "model-a")
    )

    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 1
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-a"


def test_rebuild_skips_non_image_and_leaves_manifest(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    db.upsert_file(ctx.conn(), ctx.root_id, "notes.txt", "notes.txt", ".txt", 5, 1, "sha-t", None)
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 0
    assert db.image_embeddings_count(ctx.conn()) == 0


def test_rebuild_scoped_to_path(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "keep/a.png", "sha-keep")
    _upsert_image_file(ctx, "skip/b.png", "sha-skip")
    _write_thumb(cfg, "sha-keep")
    _write_thumb(cfg, "sha-skip")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(
        image_embed_rebuild, "embed_images", lambda data, url, batch: ([[0.1] * 1024 for _ in data], "model-a")
    )

    processed = image_embed_rebuild.rebuild_image_embeddings(ctx, path="keep")
    assert processed == 1
    assert db.image_embedding_model(ctx.conn(), "sha-keep") == "model-a"
    assert db.image_embedding_model(ctx.conn(), "sha-skip") is None


def test_rebuild_default_leaves_stale_model_rows_alone(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-old", [0.2] * 1024)
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not embed a stale-model row without force")

    monkeypatch.setattr(image_embed_rebuild, "embed_images", boom)
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 0
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-old"


def test_rebuild_force_replaces_stale_model_rows(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-old", [0.2] * 1024)
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(
        image_embed_rebuild, "embed_images", lambda data, url, batch: ([[0.1] * 1024 for _ in data], "model-a")
    )

    processed = image_embed_rebuild.rebuild_image_embeddings(ctx, force=True)
    assert processed == 1
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-a"


def test_rebuild_never_recomputes_matching_model_even_with_force(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    db.upsert_image_embedding(ctx.conn(), "sha-a", "model-a", [0.2] * 1024)
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must never recompute a row already on the configured model")

    monkeypatch.setattr(image_embed_rebuild, "embed_images", boom)
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx, force=True)
    assert processed == 0


def test_rebuild_batches_requests(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("IMAGE_EMBED_BATCH_SIZE", "2")
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    for i in range(3):
        _upsert_image_file(ctx, f"{i}.png", f"sha-{i}")
        _write_thumb(cfg, f"sha-{i}")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)

    calls: list[int] = []

    def fake_embed_images(data: list[bytes], url: str, batch: int) -> tuple[list[list[float]], str]:
        calls.append(len(data))
        return [[0.1] * 1024 for _ in data], "model-a"

    monkeypatch.setattr(image_embed_rebuild, "embed_images", fake_embed_images)
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx)
    assert processed == 3
    assert calls == [2, 1]


def test_rebuild_batch_read_failure_reports_via_callback(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    # No thumbnail file written: open() fails inside the batch flush.
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not call the sidecar with no readable images")

    monkeypatch.setattr(image_embed_rebuild, "embed_images", boom)
    calls: list[bool] = []
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx, on_file=calls.append)
    assert processed == 1
    assert calls == [False]


def test_rebuild_batch_embed_failure_reports_via_callback(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)

    def boom(*a: object, **k: object) -> object:
        raise RuntimeError("sidecar down")

    monkeypatch.setattr(image_embed_rebuild, "embed_images", boom)
    calls: list[bool] = []
    processed = image_embed_rebuild.rebuild_image_embeddings(ctx, on_file=calls.append)
    assert processed == 1
    assert calls == [False]
    assert db.image_embeddings_count(ctx.conn()) == 0


def test_rebuild_no_candidates_returns_zero(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    assert image_embed_rebuild.rebuild_image_embeddings(ctx) == 0


# -- count_image_embed_candidates and start_image_embed_rebuild ----------------------------


def test_count_candidates_sums_across_contexts(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx_a = _make_context(cfg, "root-a", str(tmp_path))
    ctx_b = _make_context(cfg, "root-b", str(tmp_path))
    _upsert_image_file(ctx_a, "1.png", "sha-1")
    _upsert_image_file(ctx_b, "2.png", "sha-2")
    assert image_embed_rebuild.count_image_embed_candidates([ctx_a, ctx_b], None) == 2


def test_start_rebuild_runs_and_updates_job(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")
    _write_thumb(cfg, "sha-a")
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    monkeypatch.setattr(
        image_embed_rebuild, "embed_images", lambda data, url, batch: ([[0.1] * 1024 for _ in data], "model-a")
    )

    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    total = image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert total == 1
    snap = job.snapshot()
    assert snap["running"] is False
    assert snap["processed"] == 1
    assert snap["errors"] == 0
    assert db.image_embedding_model(ctx.conn(), "sha-a") == "model-a"


def test_start_rebuild_not_configured_reports_zero_total_without_thread_work(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"), image_embed_url="")
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "sha-a")

    def boom(*a: object, **k: object) -> object:
        raise AssertionError("must not count or embed when unconfigured")

    monkeypatch.setattr(image_embed_rebuild.db, "media_files", boom)
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    total = image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert total == 0
    snap = job.snapshot()
    assert snap["processed"] == 0
    assert snap["running"] is False


def test_start_rebuild_returns_none_when_already_running(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    assert job.try_start(5) is True
    result = image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert result is None


def test_start_rebuild_job_crash_still_releases_job(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(*a: object, **k: object) -> int:
        raise RuntimeError("boom")

    monkeypatch.setattr(image_embed_rebuild, "rebuild_image_embeddings", boom)
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    total = image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert total == 0
    snap = job.snapshot()
    assert snap["running"] is False
    assert snap["finished_at"] is not None


def test_start_rebuild_discovery_failure_releases_job(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(*a: object, **k: object) -> int:
        raise RuntimeError("cannot count")

    monkeypatch.setattr(image_embed_rebuild.db, "media_files", boom)
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    with pytest.raises(RuntimeError):
        image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert not job.snapshot()["running"]
    assert job.snapshot()["errors"] == 1


def test_start_rebuild_thread_start_failure_releases_job(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))

    def boom(*a: object, **k: object) -> None:
        raise RuntimeError("cannot start thread")

    monkeypatch.setattr(image_embed_rebuild.db, "media_files", lambda *a: [])
    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", boom)
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob

    job = ThumbnailRebuildJob()
    with pytest.raises(RuntimeError):
        image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False)
    assert not job.snapshot()["running"]
    assert job.snapshot()["errors"] == 1


def test_rebuild_counts_already_embedded_candidates_as_resolved(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fdrive_indexer.thumb_rebuild import ThumbnailRebuildJob
    monkeypatch.setattr(image_embed_rebuild.threading, "Thread", _SyncThread)
    cfg = _make_config(monkeypatch, postgres_dsn, str(tmp_path / "thumbs"))
    ctx = _make_context(cfg, "sftpgo", str(tmp_path))
    _upsert_image_file(ctx, "a.png", "same-content")
    _upsert_image_file(ctx, "copy.png", "same-content")
    db.upsert_image_embedding(ctx.conn(), "same-content", "model-a", [0.1] * 1024)
    monkeypatch.setattr(image_embed_rebuild, "image_embed_health", lambda url: _HEALTHY)
    def forbidden(*args):
        raise AssertionError("Already embedded content must not be sent again")
    monkeypatch.setattr(image_embed_rebuild, "embed_images", forbidden)
    job = ThumbnailRebuildJob()
    assert image_embed_rebuild.start_image_embed_rebuild(job, [ctx], None, False) == 2
    activity = job.activity_snapshot("imageRebuild", ["imageSearch"])
    assert activity["processed"] == activity["total"] == activity["skipped"] == 2
    assert activity["state"] == "completed"
