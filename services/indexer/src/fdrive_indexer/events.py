"""Change event payloads. Pure shaping and serialization; the actual NOTIFY/INSERT
happens in db.py.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Literal, TypedDict

EventKind = Literal["created", "changed", "deleted", "moved"]


class Event(TypedDict):
    kind: EventKind
    root: str
    path: str
    target_path: str | None
    at: str


def iso_now(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).isoformat()


def build_event(
    kind: EventKind,
    root: str,
    path: str,
    target_path: str | None = None,
    at: str | None = None,
) -> Event:
    return {
        "kind": kind,
        "root": root,
        "path": path,
        "target_path": target_path,
        "at": at or iso_now(),
    }


def to_json(event: Event) -> str:
    return json.dumps(event, separators=(",", ":"))
