from __future__ import annotations

import http.client
import json
import signal
import subprocess
import urllib.error
from typing import Any

import pytest

from fdrive_runtime import office_controller
from fdrive_runtime.office_controller import OfficeClient, OfficeLifecycle, OfficeSnapshot, parse_office_snapshot


class FakeProcess:
    def __init__(self, exit_code: int | None = None) -> None:
        self.pid = 84
        self.exit_code = exit_code
        self.wait_calls: list[float | None] = []

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        self.exit_code = 0
        return 0


class FakeResponse:
    def __init__(self, body: object = None, status: int = 200) -> None:
        self.body = json.dumps(body).encode()
        self.status = status

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, amount: int) -> bytes:
        return self.body[:amount]


def completed(returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(("stop",), returncode, "", "")


def test_parse_office_snapshot_is_strict() -> None:
    assert parse_office_snapshot({"version": 1, "revision": 4, "enabled": True}) == OfficeSnapshot(4, True)
    for body in (
        None,
        {"version": 2, "revision": 1, "enabled": True},
        {"version": 1, "revision": -1, "enabled": True},
        {"version": 1, "revision": True, "enabled": True},
        {"version": 1, "revision": 1, "enabled": "yes"},
    ):
        with pytest.raises(ValueError):
            parse_office_snapshot(body)


def test_office_client_authenticates_and_rejects_bad_responses(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    class Opener:
        def open(self, request: Any, timeout: float) -> FakeResponse:
            seen.update(token=request.headers["X-fdrive-worker-token"], timeout=timeout)
            return FakeResponse({"version": 1, "revision": 2, "enabled": False})

    monkeypatch.setattr(office_controller.urllib.request, "build_opener", lambda *_args: Opener())
    assert OfficeClient("http://api/office", "secret").fetch() == OfficeSnapshot(2, False)
    assert seen == {"token": "secret", "timeout": 5.0}

    with pytest.raises(ValueError, match="WORKER_TOKEN"):
        OfficeClient("http://api/office", "").fetch()

    class BrokenOpener:
        def open(self, *_args: object, **_kwargs: object) -> FakeResponse:
            raise urllib.error.URLError("down")

    monkeypatch.setattr(office_controller.urllib.request, "build_opener", lambda *_args: BrokenOpener())
    with pytest.raises(office_controller.EndpointUnavailable, match="unreachable"):
        OfficeClient("http://api/office", "secret").fetch()

    class MalformedOpener:
        def open(self, *_args: object, **_kwargs: object) -> FakeResponse:
            raise http.client.BadStatusLine("malformed")

    monkeypatch.setattr(office_controller.urllib.request, "build_opener", lambda *_args: MalformedOpener())
    with pytest.raises(ValueError, match="BadStatusLine"):
        OfficeClient("http://api/office", "secret").fetch()


def test_lifecycle_starts_checks_readiness_and_stops_daemon_services() -> None:
    process = FakeProcess()
    starts: list[tuple[tuple[str, ...], dict[str, object]]] = []
    stops: list[tuple[str, ...]] = []
    signals: list[tuple[int, signal.Signals]] = []

    def popen(command: tuple[str, ...], **kwargs: Any) -> FakeProcess:
        starts.append((command, kwargs))
        return process

    lifecycle = OfficeLifecycle(
        ("start-office",),
        ("stop-office",),
        "http://localhost/discovery",
        popen=popen,
        run_command=lambda command, **_kwargs: stops.append(command) or completed(),
        killpg=lambda pid, sig: signals.append((pid, sig)),
        urlopen=lambda *_args, **_kwargs: FakeResponse(status=200),
        waitpid=lambda *_args: (0, 0),
    )
    lifecycle.reconcile(OfficeSnapshot(1, True))
    lifecycle.reconcile(OfficeSnapshot(1, True))
    assert starts == [(("start-office",), {"start_new_session": True})]
    assert lifecycle.status()["status"] == "ready"

    lifecycle.reconcile(OfficeSnapshot(2, False))
    assert signals == [(84, signal.SIGTERM)]
    assert process.wait_calls == [20]
    assert stops == [("stop-office",), ("stop-office",)]
    assert lifecycle.status()["status"] == "off"

    lifecycle.reconcile(OfficeSnapshot(2, False))
    assert stops == [("stop-office",), ("stop-office",)]


def test_lifecycle_cleans_up_daemons_after_unexpected_exit_and_bounds_retries() -> None:
    processes = [FakeProcess(exit_code=1), FakeProcess(exit_code=1)]
    stops = 0

    def stop(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal stops
        stops += 1
        return completed()

    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: processes.pop(0),
        run_command=stop,
        max_attempts=2,
    )
    enabled = OfficeSnapshot(1, True)
    lifecycle.reconcile(enabled)
    lifecycle.reconcile(enabled)
    lifecycle.reconcile(enabled)
    assert stops == 3
    assert lifecycle.status()["status"] == "failed"

    failed_cleanup = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: FakeProcess(exit_code=1),
        run_command=lambda *_args, **_kwargs: completed(1),
    )
    failed_cleanup.reconcile(enabled)
    failed_cleanup.reconcile(enabled)
    failed_cleanup.reconcile(OfficeSnapshot(2, True))
    assert failed_cleanup.status()["status"] == "failed"
    assert failed_cleanup.status()["attempts"] == 3
    assert failed_cleanup.status()["error"] == "Office service shutdown exited 1"


def test_lifecycle_retries_exhausted_office_starts_once_the_retry_window_elapses() -> None:
    starts = 0
    now = 0.0

    def start(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal starts
        starts += 1
        return FakeProcess(exit_code=1)

    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=start,
        run_command=lambda *_args, **_kwargs: completed(),
        max_attempts=2,
        retry_after_seconds=60,
        clock=lambda: now,
    )
    enabled = OfficeSnapshot(1, True)
    for _ in range(4):
        lifecycle.reconcile(enabled)
    assert starts == 2
    assert lifecycle.status()["status"] == "failed"
    now = 60.0
    lifecycle.reconcile(enabled)
    assert starts == 3
    assert lifecycle.status()["attempts"] == 1


def test_lifecycle_fails_closed_and_reports_cleanup_failure() -> None:
    process = FakeProcess()

    class SlowProcess(FakeProcess):
        def wait(self, timeout: float | None = None) -> int:
            self.wait_calls.append(timeout)
            raise subprocess.TimeoutExpired("office", timeout)

    slow = SlowProcess()
    signals: list[signal.Signals] = []
    cleanup_results = iter((completed(), completed(1)))
    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: slow,
        run_command=lambda *_args, **_kwargs: next(cleanup_results),
        killpg=lambda _pid, sig: signals.append(sig),
    )
    lifecycle.reconcile(OfficeSnapshot(1, True))
    lifecycle.reconcile(None)
    assert signals == [signal.SIGTERM, signal.SIGKILL]
    assert slow.wait_calls == [20, 5]
    assert lifecycle.status()["status"] == "failed"
    assert lifecycle.status()["error"] == "office document unavailable"

    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: process,
        run_command=lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("missing")),
    )
    lifecycle.reconcile(OfficeSnapshot(1, False))
    assert lifecycle.status()["error"] == "Office service shutdown failed: OSError"


def test_lifecycle_validates_configuration_and_reports_not_ready() -> None:
    with pytest.raises(ValueError, match="start command"):
        OfficeLifecycle((), ("stop",), "http://ready")
    with pytest.raises(ValueError, match="stop command"):
        OfficeLifecycle(("start",), (), "http://ready")
    with pytest.raises(ValueError, match="readiness URL"):
        OfficeLifecycle(("start",), ("stop",), "")

    process = FakeProcess()
    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: process,
        run_command=lambda *_args, **_kwargs: completed(),
        urlopen=lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("starting")),
    )
    lifecycle.reconcile(OfficeSnapshot(1, True))
    lifecycle.reconcile(OfficeSnapshot(1, True))
    assert lifecycle.status()["status"] == "starting"

    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        popen=lambda *_args, **_kwargs: process,
        run_command=lambda *_args, **_kwargs: completed(),
        urlopen=lambda *_args, **_kwargs: (_ for _ in ()).throw(http.client.BadStatusLine("malformed")),
    )
    lifecycle.reconcile(OfficeSnapshot(1, True))
    lifecycle.reconcile(OfficeSnapshot(1, True))
    assert lifecycle.status()["status"] == "starting"


def test_lifecycle_reaps_all_orphaned_daemons_after_shutdown() -> None:
    reaped = iter(((12, 0), (13, 0), (0, 0)))
    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://ready",
        run_command=lambda *_args, **_kwargs: completed(),
        waitpid=lambda *_args: next(reaped),
    )
    lifecycle.reconcile(OfficeSnapshot(1, False))
    assert lifecycle.status()["status"] == "off"


def test_office_lifecycle_clears_a_stale_error_once_the_engine_is_back() -> None:
    lifecycle = OfficeLifecycle(
        ("start",),
        ("stop",),
        "http://office/discovery",
        popen=lambda *_args, **_kwargs: FakeProcess(),
        run_command=lambda *_args, **_kwargs: completed(),
        killpg=lambda *_args: None,
        urlopen=lambda *_args, **_kwargs: FakeResponse({}),
    )
    enabled = OfficeSnapshot(1, True)

    lifecycle.reconcile(enabled)
    lifecycle.reconcile(enabled)
    assert lifecycle.status()["status"] == "ready"
    assert lifecycle.status()["error"] is None

    lifecycle.stop("office document unavailable")
    assert lifecycle.status()["error"] == "office document unavailable"

    lifecycle.reconcile(enabled)
    assert lifecycle.status()["error"] is None
    lifecycle.reconcile(enabled)
    assert lifecycle.status()["status"] == "ready"
    assert lifecycle.status()["error"] is None
