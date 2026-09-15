from __future__ import annotations

from fdrive_ocr.stats import RunSummary, shape_health, shape_stats


def test_shape_health() -> None:
    assert shape_health(True, False) == {"ok": True, "running": False}
    assert shape_health(False, True) == {"ok": False, "running": True}


def test_shape_stats_with_no_last_run() -> None:
    body = shape_stats(
        last_run=None,
        next_run_at="2026-01-02T03:00:00+00:00",
        schedule_hour=3,
        langs="swe+eng",
        exclude_globs=["Photos/**"],
        max_mb=200,
        keep_originals=True,
        originals_retention_days=0,
        originals_count=0,
        originals_bytes=0,
        running=False,
    )
    assert body["last_run"] is None
    assert body["next_run_at"] == "2026-01-02T03:00:00+00:00"
    assert body["schedule_hour"] == 3
    assert body["langs"] == "swe+eng"
    assert body["exclude_globs"] == ["Photos/**"]
    assert body["max_mb"] == 200
    assert body["keep_originals"] is True
    assert body["originals_retention_days"] == 0
    assert body["originals_count"] == 0
    assert body["originals_bytes"] == 0
    assert body["running"] is False


def test_shape_stats_with_last_run() -> None:
    run = RunSummary(
        started_at="2026-01-01T03:00:00+00:00",
        finished_at="2026-01-01T03:05:00+00:00",
        seen=10,
        ocred=2,
        skipped=7,
        failed=1,
    )
    body = shape_stats(
        last_run=run,
        next_run_at="2026-01-02T03:00:00+00:00",
        schedule_hour=3,
        langs="eng",
        exclude_globs=[],
        max_mb=100,
        keep_originals=False,
        originals_retention_days=30,
        originals_count=5,
        originals_bytes=1024,
        running=True,
    )
    assert body["last_run"] == {
        "started_at": "2026-01-01T03:00:00+00:00",
        "finished_at": "2026-01-01T03:05:00+00:00",
        "seen": 10,
        "ocred": 2,
        "skipped": 7,
        "failed": 1,
    }
    assert body["running"] is True
    assert body["originals_retention_days"] == 30
