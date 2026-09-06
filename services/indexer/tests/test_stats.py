from fdrive_indexer.stats import RootStats, shape_health, shape_stats


def test_shape_health_ok() -> None:
    result = shape_health(["sftpgo"], {"sftpgo": True}, embed_ok=True, schema_version=1)
    assert result == {
        "ok": True,
        "roots": ["sftpgo"],
        "watcher": {"sftpgo": True},
        "embed_ok": True,
        "schema_version": 1,
    }


def test_shape_health_not_ok_when_schema_unknown() -> None:
    result = shape_health([], {}, embed_ok=False, schema_version=None)
    assert result["ok"] is False


def test_shape_stats_default_errors_sample() -> None:
    root = RootStats(root="sftpgo", counts_by_status={"indexed": 3}, chunks=10, chunks_embedded=8)
    result = shape_stats([root], thumbnails_count=2, queue_depth=0)
    assert result == {
        "roots": [
            {
                "root": "sftpgo",
                "counts_by_status": {"indexed": 3},
                "chunks": 10,
                "chunks_embedded": 8,
                "last_scan": None,
            }
        ],
        "thumbnails": 2,
        "queue_depth": 0,
        "errors_sample": [],
        "thumbnail_rebuild": None,
    }


def test_shape_stats_with_thumbnail_rebuild() -> None:
    root = RootStats(root="sftpgo", counts_by_status={"indexed": 1}, chunks=1, chunks_embedded=1)
    job = {"running": True, "processed": 2, "total": 5, "started_at": "2026-01-01T00:00:00Z", "finished_at": None, "errors": 0}
    result = shape_stats([root], thumbnails_count=0, queue_depth=0, thumbnail_rebuild=job)
    assert result["thumbnail_rebuild"] == job


def test_shape_stats_with_errors_and_last_scan() -> None:
    root = RootStats(
        root="photos",
        counts_by_status={"indexed": 1, "error": 1},
        chunks=4,
        chunks_embedded=4,
        last_scan={"started_at": "2026-01-01T00:00:00Z"},
    )
    errors = [{"path": "a.jpg", "error": "boom"}]
    result = shape_stats([root], thumbnails_count=0, queue_depth=5, errors_sample=errors)
    assert result["roots"][0]["last_scan"] == {"started_at": "2026-01-01T00:00:00Z"}
    assert result["errors_sample"] == errors
    assert result["queue_depth"] == 5
