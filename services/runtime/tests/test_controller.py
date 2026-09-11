from __future__ import annotations

import http.client
import signal
import subprocess
import threading
from typing import Any

import pytest

from fdrive_runtime import controller
from fdrive_runtime.controller import FeatureClient, FeatureSnapshot, WorkerLifecycle, parse_feature_snapshot, parse_features


class FakeProcess:
    def __init__(self, exit_code: int | None = None) -> None:
        self.pid = 42
        self.exit_code = exit_code
        self.wait_calls: list[float | None] = []

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        self.exit_code = 0
        return 0


def snapshot(revision: int = 1, **enabled: bool) -> FeatureSnapshot:
    values = {key: False for key in ("thumbnails", "textSearch", "searchOcr", "semanticSearch", "imageSearch", "pdfOcr")}
    values.update(enabled)
    return FeatureSnapshot(revision, values)


def test_parse_feature_snapshot_requires_every_known_boolean() -> None:
    assert parse_feature_snapshot({"version": 1, "revision": 2, "values": snapshot().values}).revision == 2
    with pytest.raises(ValueError, match="must be boolean"):
        parse_feature_snapshot({"version": 1, "revision": 2, "values": {}})


@pytest.mark.parametrize(
    "body",
    [
        None,
        {"version": 2, "revision": 1, "values": {}},
        {"version": 1, "revision": -1, "values": {}},
        {"version": 1, "revision": True, "values": {}},
        {"version": 1, "revision": 1, "values": []},
    ],
)
def test_parse_feature_snapshot_rejects_malformed_documents(body: object) -> None:
    with pytest.raises(ValueError):
        parse_feature_snapshot(body)


@pytest.mark.parametrize("raw", ["", "unknown", "textSearch,unknown"])
def test_parse_features_rejects_empty_or_unknown_values(raw: str) -> None:
    with pytest.raises(ValueError):
        parse_features(raw)


def test_feature_client_requires_a_token_before_requesting_the_api() -> None:
    with pytest.raises(ValueError, match="WORKER_TOKEN"):
        FeatureClient("http://api", "").fetch()


def test_feature_client_normalizes_http_protocol_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenOpener:
        def open(self, *_args: object, **_kwargs: object) -> object:
            raise http.client.BadStatusLine("malformed")

    monkeypatch.setattr(controller.urllib.request, "build_opener", lambda *_args: BrokenOpener())
    with pytest.raises(ValueError, match="BadStatusLine"):
        FeatureClient("http://api", "token").fetch()


def test_lifecycle_rejects_invalid_configuration() -> None:
    with pytest.raises(ValueError, match="command"):
        WorkerLifecycle((), frozenset({"thumbnails"}))
    with pytest.raises(ValueError, match="known features"):
        WorkerLifecycle(("worker",), frozenset({"unknown"}))
    assert parse_features("thumbnails,textSearch") == frozenset({"thumbnails", "textSearch"})


def test_lifecycle_only_starts_for_a_mapped_enabled_feature() -> None:
    starts: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def popen(command: tuple[str, ...], **kwargs: Any) -> FakeProcess:
        starts.append((command, kwargs))
        return FakeProcess()

    lifecycle = WorkerLifecycle(("worker",), frozenset({"semanticSearch"}), popen=popen)
    lifecycle.reconcile(snapshot())
    assert starts == []
    assert lifecycle.status()["status"] == "off"
    lifecycle.reconcile(snapshot(1, semanticSearch=True))
    assert starts == [(("worker",), {"start_new_session": True})]
    lifecycle.reconcile(snapshot(1, semanticSearch=True))
    assert len(starts) == 1


def test_lifecycle_stops_the_process_group_on_disable_and_on_stale_document() -> None:
    process = FakeProcess()
    signals: list[tuple[int, signal.Signals]] = []
    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"textSearch"}),
        popen=lambda *_args, **_kwargs: process,
        killpg=lambda pid, sig: signals.append((pid, sig)),
    )
    lifecycle.reconcile(snapshot(textSearch=True))
    lifecycle.reconcile(snapshot(2))
    assert signals == [(42, signal.SIGTERM)]
    assert lifecycle.status()["status"] == "off"
    lifecycle.reconcile(None)
    assert lifecycle.status()["error"] == "feature document unavailable"


def test_lifecycle_bounds_failed_starts_until_a_new_revision() -> None:
    attempts = 0

    def broken(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal attempts
        attempts += 1
        raise OSError("no executable")

    lifecycle = WorkerLifecycle(("worker",), frozenset({"pdfOcr"}), popen=broken, max_attempts=2)
    lifecycle.reconcile(snapshot(1, pdfOcr=True))
    lifecycle.reconcile(snapshot(1, pdfOcr=True))
    lifecycle.reconcile(snapshot(1, pdfOcr=True))
    assert attempts == 2
    assert lifecycle.status()["status"] == "failed"
    lifecycle.reconcile(snapshot(2, pdfOcr=True))
    assert attempts == 3


def test_lifecycle_retries_exhausted_starts_once_the_retry_window_elapses() -> None:
    attempts = 0
    now = 0.0

    def broken(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal attempts
        attempts += 1
        raise OSError("no executable")

    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"semanticSearch"}),
        popen=broken,
        max_attempts=2,
        retry_after_seconds=60,
        clock=lambda: now,
    )
    enabled = snapshot(1, semanticSearch=True)
    for _ in range(4):
        lifecycle.reconcile(enabled)
    assert attempts == 2
    assert lifecycle.status()["status"] == "failed"
    assert lifecycle.status()["error"] == "worker exceeded bounded startup retries"

    now = 59.0
    lifecycle.reconcile(enabled)
    assert attempts == 2
    assert lifecycle.status()["status"] == "failed"

    now = 60.0
    lifecycle.reconcile(enabled)
    assert attempts == 3
    assert lifecycle.status()["attempts"] == 1
    lifecycle.reconcile(enabled)
    lifecycle.reconcile(enabled)
    assert attempts == 4
    assert lifecycle.status()["status"] == "failed"
    now = 200.0
    lifecycle.reconcile(enabled)
    assert attempts == 5


def test_parse_retry_after_defaults_and_rejects_non_positive() -> None:
    assert controller.parse_retry_after("") == controller.DEFAULT_RETRY_AFTER_SECONDS
    assert controller.parse_retry_after("12.5") == 12.5
    with pytest.raises(ValueError, match="must be positive"):
        controller.parse_retry_after("0")


def test_lifecycle_retries_an_exited_child_and_escalates_to_kill_on_timeout() -> None:
    processes = [FakeProcess(exit_code=1), FakeProcess()]
    signals: list[signal.Signals] = []

    class SlowProcess(FakeProcess):
        def wait(self, timeout: float | None = None) -> int:
            self.wait_calls.append(timeout)
            raise subprocess.TimeoutExpired("worker", timeout)

    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"thumbnails"}),
        popen=lambda *_args, **_kwargs: processes.pop(0),
        killpg=lambda _pid, sig: signals.append(sig),
    )
    lifecycle.reconcile(snapshot(thumbnails=True))
    lifecycle.reconcile(snapshot(thumbnails=True))
    assert lifecycle.status()["child"] is True

    slow = SlowProcess()
    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"thumbnails"}),
        popen=lambda *_args, **_kwargs: slow,
        killpg=lambda _pid, sig: signals.append(sig),
    )
    lifecycle.reconcile(snapshot(thumbnails=True))
    lifecycle.reconcile(snapshot())
    assert signals[-2:] == [signal.SIGTERM, signal.SIGKILL]
    assert slow.wait_calls == [10, 5]


def test_lifecycle_ignores_an_already_gone_process_and_kill_errors() -> None:
    gone = FakeProcess(exit_code=1)
    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"thumbnails"}),
        popen=lambda *_args, **_kwargs: gone,
        killpg=lambda _pid, _signal: (_ for _ in ()).throw(OSError("gone")),
    )
    lifecycle.reconcile(snapshot(thumbnails=True))
    lifecycle.reconcile(snapshot())
    assert lifecycle.status()["status"] == "off"


def test_lifecycle_status_retries_if_stop_changes_state_during_child_poll() -> None:
    class PausedStatusPoll(FakeProcess):
        def __init__(self) -> None:
            super().__init__()
            self.status_poll_started = threading.Event()
            self.resume_status_poll = threading.Event()

        def poll(self) -> int | None:
            if threading.current_thread().name == "status-reader":
                self.status_poll_started.set()
                assert self.resume_status_poll.wait(2)
            return super().poll()

    process = PausedStatusPoll()
    lifecycle = WorkerLifecycle(
        ("worker",),
        frozenset({"thumbnails"}),
        popen=lambda *_args, **_kwargs: process,
        killpg=lambda *_args: None,
    )
    lifecycle.reconcile(snapshot(thumbnails=True))

    result: list[dict[str, object]] = []
    reader = threading.Thread(target=lambda: result.append(lifecycle.status()), name="status-reader")
    reader.start()
    assert process.status_poll_started.wait(2)
    lifecycle.stop("feature document unavailable")
    process.resume_status_poll.set()
    reader.join(2)

    assert not reader.is_alive()
    assert result == [
        {
            "status": "failed",
            "revision": 1,
            "features": ["thumbnails"],
            "attempts": 1,
            "child": False,
            "error": "feature document unavailable",
        }
    ]


def test_lifecycle_treats_http_protocol_errors_as_not_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FDRIVE_RUNTIME_READY_URL", "http://worker/ready")
    monkeypatch.setattr(
        controller.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(http.client.BadStatusLine("malformed")),
    )
    lifecycle = WorkerLifecycle(("worker",), frozenset({"thumbnails"}))
    assert lifecycle._child_ready() is False


def test_main_always_starts_the_feature_polling_controller(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake_run(
        lifecycle: WorkerLifecycle,
        client: FeatureClient,
        interval: float,
        stale_seconds: float,
        _sleep: object,
    ) -> None:
        seen.update(lifecycle=lifecycle, client=client, interval=interval, stale_seconds=stale_seconds)
        raise KeyboardInterrupt

    monkeypatch.setattr(controller.sys, "argv", ["controller", "python3", "-m", "worker"])
    monkeypatch.setenv("FDRIVE_RUNTIME_FEATURES", "imageSearch")
    monkeypatch.setenv("FDRIVE_WORKER_TOKEN", "token")
    monkeypatch.setattr(controller, "serve_status", lambda *_args: None)
    monkeypatch.setattr(controller, "run", fake_run)
    monkeypatch.setattr(controller.signal, "signal", lambda *_args: None)

    controller.main()

    lifecycle = seen["lifecycle"]
    assert isinstance(lifecycle, WorkerLifecycle)
    assert lifecycle.command == ("python3", "-m", "worker")
    assert lifecycle.features == frozenset({"imageSearch"})
    assert seen["interval"] == 3
    assert seen["stale_seconds"] == 9
