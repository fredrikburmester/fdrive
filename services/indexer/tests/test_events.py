import json
from datetime import UTC, datetime

from fdrive_indexer.events import build_event, iso_now, to_json


def test_iso_now_fixed() -> None:
    dt = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    assert iso_now(dt) == "2026-01-02T03:04:05+00:00"


def test_build_event_defaults_at() -> None:
    ev = build_event("created", "sftpgo", "a/b.txt")
    assert ev["kind"] == "created"
    assert ev["root"] == "sftpgo"
    assert ev["path"] == "a/b.txt"
    assert ev["target_path"] is None
    assert ev["at"]


def test_build_event_moved_with_target() -> None:
    ev = build_event("moved", "sftpgo", "old.txt", target_path="new.txt", at="2026-01-01T00:00:00+00:00")
    assert ev == {
        "kind": "moved",
        "root": "sftpgo",
        "path": "old.txt",
        "target_path": "new.txt",
        "at": "2026-01-01T00:00:00+00:00",
    }


def test_to_json_round_trips() -> None:
    ev = build_event("deleted", "photos", "a.jpg", at="2026-01-01T00:00:00+00:00")
    raw = to_json(ev)
    assert json.loads(raw) == dict(ev)
