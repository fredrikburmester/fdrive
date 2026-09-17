from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from fdrive_indexer.activity import RootActivity
from fdrive_indexer.embed_backoff import EmbedBackoff
from fdrive_indexer.features import FeatureConfiguration, FeatureValues
from fdrive_indexer.server import ServerState, create_app


def test_discovery_has_no_ratio_and_watcher_jobs_do_not_change_scan_totals() -> None:
    activity = RootActivity()
    activity.queue_scan(["thumbnails"], 1)
    activity.queue_scan(["thumbnails"], 1)
    assert len(activity.snapshot()) == 1
    assert activity.snapshot()[0]["phase"] == "queued"
    assert activity.snapshot()[0]["root"] is None
    activity.stop_queued()
    assert activity.snapshot() == []
    scan = activity.start_scan(["thumbnails"], 1)["thumbnails"]
    scan.enqueue()
    scan.enqueue()
    scan.advance()
    assert scan.snapshot()["total"] is None
    scan.discovered()
    assert scan.snapshot()["total"] == 2
    first = activity.start_watch(["thumbnails"], 1)
    second = activity.start_watch(["thumbnails"], 1)
    assert first[0].id == second[0].id
    activity.finish_watch(first, True)
    assert second[0].snapshot()["state"] == "running"
    activity.finish_watch(second, False)
    assert second[0].snapshot()["state"] == "failed"
    assert scan.snapshot()["total"] == 2
    scan.advance(skipped=True)
    scan.finish()
    assert scan.snapshot()["state"] == "completed"
    assert scan.snapshot()["skipped"] == 1
    third = activity.start_watch(["thumbnails"], 2)
    assert third[0].id != second[0].id
    activity.finish_watch(third, True)


def test_concurrent_completions_are_not_lost() -> None:
    activity = RootActivity()
    handles = [activity.start_watch(["textSearch", "semanticSearch"], 4) for _ in range(100)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda handle: activity.finish_watch(handle, True), handles))
    assert all(operation["processed"] == 100 and operation["state"] == "completed" for operation in activity.snapshot())


def test_activity_read_is_storage_free_and_exposes_embedding_waits() -> None:
    activity = RootActivity("private-root")
    backoff = EmbedBackoff(pause_seconds=0)
    configuration = FeatureConfiguration(2, FeatureValues(False, True, False, True, False, False))
    activity.start_scan(["textSearch", "semanticSearch"], 2)
    ctx = SimpleNamespace(activity=activity, embed_backoff=backoff, feature_configuration=lambda: configuration)
    def forbidden() -> None:
        raise AssertionError("status must not read storage")
    state = ServerState(contexts={"private-root": ctx}, watchers={}, wake_events={},
                        conn_factory=forbidden, schema_version=forbidden)  # type: ignore[arg-type]
    client = TestClient(create_app(state))
    assert backoff.waiting() is False
    backoff.note_failure()
    assert backoff.waiting() is True
    data = client.get("/activity").json()
    assert {operation["root"] for operation in data["operations"]} == {"private-root"}
    assert data["operations"][0]["state"] == "running"
    assert data["operations"][1]["state"] == "waiting"
    assert data["operations"][1]["total"] is None
    backoff.note_success()
    assert client.get("/activity").json()["operations"][1]["state"] == "running"


def test_watcher_tracks_queued_work_and_cleans_up_submission_failure(tmp_path: Path) -> None:
    from fdrive_indexer.watcher import Watcher

    calls = []
    def queued(path: str):
        calls.append((path, "queued"))
        return lambda result: calls.append((path, result))
    watcher = Watcher(str(tmp_path), lambda _: None, lambda *args: "indexed", lambda *args: 0,
                      lambda *args: 0, on_queue=queued)
    path = tmp_path / "one.txt"
    path.write_text("one")
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert watcher._submit(pool, str(path)).result() == "indexed"
        assert calls == [(str(path), "queued"), (str(path), "indexed")]
        with pytest.raises(RuntimeError):
            watcher._submit(pool, str(path))
        assert calls[-1] == (str(path), "error")
    finally:
        watcher.stop()
