"""Fail-closed controller for a bundled optional subprocess.

The controller has no Docker access. It keeps a tiny HTTP status endpoint alive
and starts its child only while the API's authenticated feature document says a
mapped capability is enabled. A stale/malformed document stops the child, so a
partial API outage cannot leave optional processing running unexpectedly.
"""

from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol

FEATURE_KEYS = frozenset({"thumbnails", "textSearch", "searchOcr", "semanticSearch", "imageSearch", "pdfOcr"})
DEFAULT_FEATURES_URL = "http://api:3001/api/v1/internal/features"
DEFAULT_RETRY_AFTER_SECONDS = 300.0


def parse_retry_after(raw: str) -> float:
    value = float(raw) if raw else DEFAULT_RETRY_AFTER_SECONDS
    if value <= 0:
        raise ValueError("FDRIVE_RUNTIME_RETRY_AFTER_SECONDS must be positive")
    return value


class EndpointUnavailable(ValueError):
    """The feature endpoint could not be reached, as distinct from answering
    with something the contract rejects.

    The two deserve different patience. A document that arrives and violates
    the contract is a real signal and should fail closed quickly. A poll that
    never completed usually means the host is busy — and stopping a healthy
    child for that reloads a model, which makes the host busier, which fails
    the next poll. Under load that loop stopped workers that had never failed
    to start.
    """


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> urllib.request.Request | None:
        return None


@dataclass(frozen=True)
class FeatureSnapshot:
    revision: int
    values: Mapping[str, bool]


class Process(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...


class StatusLifecycle(Protocol):
    def status(self) -> Mapping[str, object]: ...


def parse_feature_snapshot(body: object) -> FeatureSnapshot:
    """Validate the worker contract strictly; callers must fail closed on errors."""
    if not isinstance(body, dict) or body.get("version") != 1:
        raise ValueError("feature document must have version 1")
    revision = body.get("revision")
    values = body.get("values")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("feature document revision must be a non-negative integer")
    if not isinstance(values, dict):
        raise ValueError("feature document values must be an object")
    parsed: dict[str, bool] = {}
    for key in FEATURE_KEYS:
        value = values.get(key)
        if not isinstance(value, bool):
            raise ValueError(f"feature document {key} must be boolean")
        parsed[key] = value
    return FeatureSnapshot(revision=revision, values=parsed)


class FeatureClient:
    def __init__(self, url: str, token: str, timeout_seconds: float = 5.0) -> None:
        self.url = url
        self.token = token
        self.timeout_seconds = timeout_seconds

    def fetch(self) -> FeatureSnapshot:
        if not self.token:
            raise ValueError("FDRIVE_WORKER_TOKEN is required by the runtime controller")
        request = urllib.request.Request(self.url, headers={"x-fdrive-worker-token": self.token})
        try:
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - fixed compose URL
                if response.status != 200:
                    raise ValueError(f"feature endpoint returned {response.status}")
                raw = response.read(64 * 1024 + 1)
                if len(raw) > 64 * 1024:
                    raise ValueError("feature endpoint response is too large")
                return parse_feature_snapshot(json.loads(raw))
        except (http.client.HTTPException, urllib.error.URLError, TimeoutError) as error:
            raise EndpointUnavailable(f"feature endpoint unreachable: {type(error).__name__}") from error
        except json.JSONDecodeError as error:
            raise ValueError(f"feature document is not JSON: {type(error).__name__}") from error


class WorkerLifecycle:
    """Small deterministic subprocess state machine, independent of HTTP polling."""

    def __init__(
        self,
        command: Sequence[str],
        features: frozenset[str],
        popen: Callable[..., Process] = subprocess.Popen,
        killpg: Callable[[int, signal.Signals], None] = os.killpg,
        max_attempts: int = 3,
        retry_after_seconds: float = DEFAULT_RETRY_AFTER_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not command:
            raise ValueError("worker command is required")
        if not features or not features <= FEATURE_KEYS:
            raise ValueError("worker must map one or more known features")
        self.command = tuple(command)
        self.features = features
        self._popen = popen
        self._killpg = killpg
        self._max_attempts = max_attempts
        self._retry_after_seconds = retry_after_seconds
        self._clock = clock
        self._process: Process | None = None
        self._revision: int | None = None
        self._attempts = 0
        self._exhausted_at: float | None = None
        self._status = "preparing"
        self._error: str | None = None
        self._ready_url = os.environ.get("FDRIVE_RUNTIME_READY_URL", "")
        self._publish_status()

    def desired(self, snapshot: FeatureSnapshot) -> bool:
        return any(snapshot.values[key] for key in self.features)

    def reconcile(self, snapshot: FeatureSnapshot | None, reason: str = "feature document unavailable") -> None:
        if snapshot is None:
            self.stop(reason)
            return
        if snapshot.revision != self._revision:
            self._revision = snapshot.revision
            self._reset_attempts()
        if not self.desired(snapshot):
            self.stop(None)
            return
        if self._process is not None and self._process.poll() is None:
            self._status = "ready" if self._child_ready() else "preparing"
            if self._status == "ready":
                # `error` describes the current state or it is worthless as a
                # diagnostic. A transient stop (an api recreate during an update,
                # say) leaves a reason behind that neither the restart path nor
                # this one used to clear, so a healthy worker kept serving
                # `ready` next to a resolved failure until the retry window
                # elapsed or someone saved settings.
                self._error = None
            self._publish_status()
            return
        self._process = None
        if self._attempts >= self._max_attempts:
            if not self._retry_window_elapsed():
                self._status = "failed"
                self._error = "worker exceeded bounded startup retries"
                self._publish_status()
                return
            self._reset_attempts()
        self._attempts += 1
        try:
            self._process = self._popen(self.command, start_new_session=True)
            self._status = "preparing"
            self._error = None
        except OSError as error:
            self._status = "failed"
            self._error = f"worker start failed: {type(error).__name__}"
        self._publish_status()

    def _reset_attempts(self) -> None:
        self._attempts = 0
        self._exhausted_at = None
        self._error = None

    def _retry_window_elapsed(self) -> bool:
        """Bounded retries latch the worker off only for `retry_after_seconds`.

        A revision bump still clears them immediately; without this window an
        API restart under load could leave an enabled feature dead until an
        owner happened to save settings again.
        """
        if self._exhausted_at is None:
            self._exhausted_at = self._clock()
            return False
        return self._clock() - self._exhausted_at >= self._retry_after_seconds

    def stop(self, error: str | None) -> None:
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            self._status = "stopping"
            self._publish_status()
            try:
                self._killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self._killpg(process.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        self._status = "off" if error is None else "failed"
        self._error = error
        self._publish_status()

    def _publish_status(self) -> None:
        # HTTP handlers run on separate threads. Publish one immutable object so
        # a handler never combines fields from different lifecycle transitions.
        self._reported_status = (
            self._status,
            self._revision,
            self._attempts,
            self._process,
            self._error,
        )

    def _child_ready(self) -> bool:
        if not self._ready_url:
            return False
        try:
            with urllib.request.urlopen(self._ready_url, timeout=1) as response:  # noqa: S310 - compose localhost only
                return bool(response.status == 200)
        except (http.client.HTTPException, urllib.error.URLError, TimeoutError):
            return False

    def status(self) -> dict[str, object]:
        while True:
            snapshot = self._reported_status
            status, revision, attempts, process, error = snapshot
            child = process is not None and process.poll() is None
            if snapshot is self._reported_status:
                return {
                    "status": status,
                    "revision": revision,
                    "features": sorted(self.features),
                    "attempts": attempts,
                    "child": child,
                    "error": error,
                }


class RuntimeServer(ThreadingHTTPServer):
    lifecycle: StatusLifecycle


class RuntimeHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - HTTP verb required by stdlib
        if self.path not in {"/health", "/runtime"}:
            self.send_error(404)
            return
        body = json.dumps(self.server.lifecycle.status()).encode("utf-8")  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def serve_status(lifecycle: StatusLifecycle, port: int) -> RuntimeServer:
    server = RuntimeServer(("0.0.0.0", port), RuntimeHandler)  # noqa: S104 - compose network only
    server.lifecycle = lifecycle
    threading.Thread(target=server.serve_forever, daemon=True, name="runtime-status").start()
    return server


def parse_features(raw: str) -> frozenset[str]:
    features = frozenset(part.strip() for part in raw.split(",") if part.strip())
    if not features or not features <= FEATURE_KEYS:
        raise ValueError("FDRIVE_RUNTIME_FEATURES must contain known feature names")
    return features


def run(
    lifecycle: WorkerLifecycle,
    client: FeatureClient,
    interval: float,
    stale_seconds: float,
    sleep: Callable[[float], None],
    unreachable_seconds: float | None = None,
) -> None:
    """Poll the feature document and reconcile the child against it.

    Two windows rather than one, for the reason `EndpointUnavailable` gives:
    a malformed or rejected document fails closed after `stale_seconds`, an
    unreachable endpoint after the longer `unreachable_seconds`. Both still
    fail closed, so a real API outage cannot leave optional processing running.
    """
    unreachable_after = stale_seconds if unreachable_seconds is None else unreachable_seconds
    last_good_at: float | None = None
    while True:
        try:
            snapshot = client.fetch()
            last_good_at = time.monotonic()
            lifecycle.reconcile(snapshot)
        except EndpointUnavailable:
            if last_good_at is None or time.monotonic() - last_good_at >= unreachable_after:
                lifecycle.reconcile(None, "feature endpoint unreachable")
        except ValueError:
            if last_good_at is None or time.monotonic() - last_good_at >= stale_seconds:
                lifecycle.reconcile(None)
        sleep(interval)


def main() -> None:
    # Docker appends CMD after ENTRYPOINT. Treat it verbatim as the child
    # command so model-server flags are never parsed as controller flags.
    command = sys.argv[1:]
    lifecycle = WorkerLifecycle(
        command,
        parse_features(os.environ.get("FDRIVE_RUNTIME_FEATURES", "")),
        retry_after_seconds=parse_retry_after(os.environ.get("FDRIVE_RUNTIME_RETRY_AFTER_SECONDS", "")),
    )
    client = FeatureClient(
        os.environ.get("FDRIVE_FEATURES_URL", DEFAULT_FEATURES_URL),
        os.environ.get("FDRIVE_WORKER_TOKEN", ""),
    )
    serve_status(lifecycle, int(os.environ.get("FDRIVE_RUNTIME_PORT", "8099")))
    interval = float(os.environ.get("FDRIVE_RUNTIME_POLL_SECONDS", "3"))
    stale_seconds = float(os.environ.get("FDRIVE_RUNTIME_STALE_SECONDS", "9"))
    unreachable_seconds = float(os.environ.get("FDRIVE_RUNTIME_UNREACHABLE_SECONDS", "60"))
    if interval <= 0 or stale_seconds < interval:
        raise ValueError("runtime polling intervals must be positive and stale window >= poll interval")
    if unreachable_seconds < stale_seconds:
        raise ValueError("runtime unreachable window must be >= stale window")

    def stop_handler(_signum: int, _frame: object) -> None:
        lifecycle.stop(None)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    try:
        run(lifecycle, client, interval, stale_seconds, time.sleep, unreachable_seconds)
    except KeyboardInterrupt:
        lifecycle.stop(None)


if __name__ == "__main__":
    main()
