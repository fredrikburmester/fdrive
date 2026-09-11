from __future__ import annotations

import httpx
import pytest

from fdrive_indexer.embed_backoff import EmbedBackoff, is_backend_outage


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("[Errno 111] Connection refused"),
        httpx.ConnectError("[Errno -2] Name or service not known"),
        httpx.ReadTimeout("timed out"),
    ],
)
def test_transport_failures_are_backend_outages(error: Exception) -> None:
    assert is_backend_outage(error) is True


@pytest.mark.parametrize(
    "error",
    [
        httpx.HTTPStatusError("413", request=httpx.Request("POST", "http://embed/embed"), response=httpx.Response(413)),
        RuntimeError("bad payload"),
    ],
)
def test_answers_from_a_live_backend_stay_per_file(error: Exception) -> None:
    assert is_backend_outage(error) is False


def test_one_outage_reports_once_and_suppresses_the_files_behind_it() -> None:
    now = 0.0
    backoff = EmbedBackoff(pause_seconds=60, clock=lambda: now)

    assert backoff.paused() is False
    assert backoff.note_failure() is True
    assert backoff.paused() is True
    # Every other file in the pass sees the pause instead of a second socket.
    assert backoff.note_failure() is False


def test_the_pause_expires_so_one_file_reprobes_without_reporting_again() -> None:
    now = 0.0
    backoff = EmbedBackoff(pause_seconds=60, clock=lambda: now)
    backoff.note_failure()

    now = 59.0
    assert backoff.paused() is True
    now = 60.0
    assert backoff.paused() is False
    # The probe fails too: the pause extends, but the outage is already reported.
    assert backoff.note_failure() is False
    assert backoff.paused() is True


def test_recovery_is_reported_once_and_clears_the_pause() -> None:
    now = 0.0
    backoff = EmbedBackoff(pause_seconds=60, clock=lambda: now)
    backoff.note_failure()
    now = 60.0

    assert backoff.note_success() is True
    assert backoff.paused() is False
    assert backoff.note_success() is False
    # A later outage is a new one and reports again.
    assert backoff.note_failure() is True
