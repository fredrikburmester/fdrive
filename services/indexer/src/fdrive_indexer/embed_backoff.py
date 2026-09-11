"""Whole-service pause for the text embedding backend.

A missing embed backend is a service condition, not a per-file one. Without a
gate, a scan that starts while TEI is still loading its model — or while the
container is being replaced and DNS stops resolving — logs one connection
error per file and hammers the socket at the scan's full throughput, burying
real errors in the process. The gate turns that into one log line per outage:
affected files keep their FTS chunks, stay ``partial``, and the next scan
backfills their vectors.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import httpx

DEFAULT_PAUSE_SECONDS = 60.0


def is_backend_outage(error: BaseException) -> bool:
    """Whether this failure is the backend being absent rather than one bad payload.

    ``httpx.TransportError`` covers connection refused (the model-load window),
    name resolution failure (container replacement) and timeouts. An
    ``HTTPStatusError`` is an answer from a backend that is up, so it stays a
    per-file failure and is logged per file.
    """
    return isinstance(error, httpx.TransportError)


class EmbedBackoff:
    """Pauses embedding for ``pause_seconds`` after the backend goes away.

    Thread-safe: a scan drives this from its worker pool. The pause is
    time-based rather than scan-scoped so a short outage inside one scan and a
    long one spanning several both cost a bounded number of probes.
    """

    def __init__(
        self,
        pause_seconds: float = DEFAULT_PAUSE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._pause_seconds = pause_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._resume_at: float | None = None

    def paused(self) -> bool:
        with self._lock:
            return self._resume_at is not None and self._clock() < self._resume_at

    def note_failure(self) -> bool:
        """Pause embedding; True only for the first failure of an outage.

        A probe that fails after the window elapsed extends the pause without
        reporting again, so one unreachable backend produces one log line.
        """
        with self._lock:
            first = self._resume_at is None
            self._resume_at = self._clock() + self._pause_seconds
            return first

    def note_success(self) -> bool:
        """Clear the pause; True only when this ends an outage."""
        with self._lock:
            recovered = self._resume_at is not None
            self._resume_at = None
            return recovered
