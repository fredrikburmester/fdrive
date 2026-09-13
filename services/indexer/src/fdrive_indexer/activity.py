"""Thread-safe, bounded live work counters. Reading them never touches storage."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class Operation:
    kind: str
    features: list[str]
    revision: int
    id: str = field(default_factory=lambda: str(uuid4()))
    phase: str = "discovering"
    state: str = "running"
    processed: int = 0
    scheduled: int = 0
    total: int | None = None
    errors: int = 0
    skipped: int = 0
    started_at: str = field(default_factory=timestamp)
    finished_at: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def enqueue(self) -> None:
        with self._lock:
            self.scheduled += 1

    def advance(self, ok: bool = True, skipped: bool = False) -> None:
        with self._lock:
            self.processed += 1
            self.errors += int(not ok)
            self.skipped += int(skipped)

    def discovered(self) -> None:
        with self._lock:
            self.total = self.scheduled
            self.phase = "processing"

    def finish(self, state: str = "completed") -> None:
        with self._lock:
            self.state = "failed" if state == "completed" and self.errors else state
            self.finished_at = timestamp()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id, "kind": self.kind, "features": list(self.features), "revision": self.revision,
                "state": self.state, "phase": self.phase, "processed": self.processed, "total": self.total,
                "errors": self.errors, "skipped": self.skipped, "unit": "files",
                "startedAt": self.started_at, "finishedAt": self.finished_at,
            }


class RootActivity:
    """One scan per root and one bounded aggregate of concurrent watcher work."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scan: dict[str, Operation] = {}
        self._watch: dict[str, Operation] = {}
        self._queued: Operation | None = None

    def queue_scan(self, features: list[str], revision: int) -> None:
        with self._lock:
            if self._queued is None:
                self._queued = Operation("reindex", features, revision, phase="queued")

    def stop_queued(self) -> None:
        with self._lock:
            self._queued = None

    def start_scan(self, features: list[str], revision: int) -> dict[str, Operation]:
        with self._lock:
            self._queued = None
            self._scan = {feature: Operation("scan", [feature], revision) for feature in features}
            return dict(self._scan)

    def start_watch(self, features: list[str], revision: int) -> list[Operation]:
        with self._lock:
            result = []
            for feature in features:
                operation = self._watch.get(feature)
                if operation is None or operation.state not in ("running", "waiting"):
                    operation = self._watch[feature] = Operation("watch", [feature], revision, phase="processing")
                operation.enqueue()
                result.append(operation)
            return result

    def finish_watch(self, operations: list[Operation], ok: bool,
                     outcomes: dict[str, tuple[bool, bool]] | None = None) -> None:
        with self._lock:
            for operation in operations:
                result, skipped = (outcomes or {}).get(operation.features[0], (ok, outcomes is not None))
                operation.advance(result, skipped)
                if operation.processed == operation.scheduled:
                    operation.finish()

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            operations = [*self._scan.values(), *self._watch.values(), *([self._queued] if self._queued else [])]
            return [operation.snapshot() for operation in operations]
