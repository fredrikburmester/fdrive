"""Fail-closed lifecycle controller for the bundled ONLYOFFICE server.

ONLYOFFICE's upstream entrypoint daemonizes nginx, supervisor, and its editor
processes. Stopping only that entrypoint therefore leaves the expensive editor
running. This controller follows the owner's persisted setting and always runs
an explicit service shutdown after the entrypoint exits.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from fdrive_runtime.controller import DEFAULT_RETRY_AFTER_SECONDS, NoRedirect, parse_retry_after, serve_status

DEFAULT_OFFICE_URL = "http://api:3001/api/v1/internal/office"


@dataclass(frozen=True)
class OfficeSnapshot:
    revision: int
    enabled: bool


class Process(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...


def parse_office_snapshot(body: object) -> OfficeSnapshot:
    if not isinstance(body, dict) or body.get("version") != 1:
        raise ValueError("office document must have version 1")
    revision = body.get("revision")
    enabled = body.get("enabled")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("office document revision must be a non-negative integer")
    if not isinstance(enabled, bool):
        raise ValueError("office document enabled must be boolean")
    return OfficeSnapshot(revision=revision, enabled=enabled)


class OfficeClient:
    def __init__(self, url: str, token: str, timeout_seconds: float = 2.0) -> None:
        self.url = url
        self.token = token
        self.timeout_seconds = timeout_seconds

    def fetch(self) -> OfficeSnapshot:
        if not self.token:
            raise ValueError("FDRIVE_WORKER_TOKEN is required by the Office controller")
        request = urllib.request.Request(self.url, headers={"x-fdrive-worker-token": self.token})
        try:
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - fixed compose URL
                if response.status != 200:
                    raise ValueError(f"office endpoint returned {response.status}")
                raw = response.read(64 * 1024 + 1)
                if len(raw) > 64 * 1024:
                    raise ValueError("office endpoint response is too large")
                return parse_office_snapshot(json.loads(raw))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise ValueError(f"office endpoint unavailable: {type(error).__name__}") from error


class OfficeLifecycle:
    def __init__(
        self,
        command: Sequence[str],
        stop_command: Sequence[str],
        ready_url: str,
        popen: Callable[..., Process] = subprocess.Popen,
        run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        killpg: Callable[[int, signal.Signals], None] = os.killpg,
        urlopen: Callable[..., object] = urllib.request.urlopen,
        waitpid: Callable[[int, int], tuple[int, int]] = os.waitpid,
        max_attempts: int = 3,
        retry_after_seconds: float = DEFAULT_RETRY_AFTER_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not command:
            raise ValueError("Office start command is required")
        if not stop_command:
            raise ValueError("Office stop command is required")
        if not ready_url:
            raise ValueError("Office readiness URL is required")
        self.command = tuple(command)
        self.stop_command = tuple(stop_command)
        self.ready_url = ready_url
        self._popen = popen
        self._run_command = run_command
        self._killpg = killpg
        self._urlopen = urlopen
        self._waitpid = waitpid
        self._max_attempts = max_attempts
        self._retry_after_seconds = retry_after_seconds
        self._clock = clock
        self._process: Process | None = None
        self._revision: int | None = None
        self._attempts = 0
        self._exhausted_at: float | None = None
        self._status = "preparing"
        self._error: str | None = None
        self._services_stopped = False

    def reconcile(self, snapshot: OfficeSnapshot | None) -> None:
        if snapshot is None:
            self.stop("office document unavailable")
            return
        if snapshot.revision != self._revision:
            self._revision = snapshot.revision
            self._reset_attempts()
        if not snapshot.enabled:
            self.stop(None)
            return
        if self._process is not None and self._process.poll() is None:
            self._status = "ready" if self._ready() else "starting"
            return
        if self._process is not None:
            self._process = None
        if not self._services_stopped:
            cleanup_error = self._stop_services()
            if cleanup_error is not None:
                self._attempts = self._max_attempts
                self._status = "failed"
                self._error = cleanup_error
                return
        if self._attempts >= self._max_attempts:
            if not self._retry_window_elapsed():
                self._status = "failed"
                self._error = "Office exceeded bounded startup retries"
                return
            self._reset_attempts()
        self._attempts += 1
        try:
            self._process = self._popen(self.command, start_new_session=True)
            self._services_stopped = False
            self._status = "starting"
        except OSError as error:
            self._status = "failed"
            self._error = f"Office start failed: {type(error).__name__}"

    def _reset_attempts(self) -> None:
        self._attempts = 0
        self._exhausted_at = None
        self._error = None

    def _retry_window_elapsed(self) -> bool:
        """Bounded retries latch Office off only for `retry_after_seconds`;
        a revision bump still clears them immediately."""
        if self._exhausted_at is None:
            self._exhausted_at = self._clock()
            return False
        return self._clock() - self._exhausted_at >= self._retry_after_seconds

    def stop(self, error: str | None) -> None:
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            self._status = "stopping"
            try:
                self._killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=20)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self._killpg(process.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        cleanup_error = None if self._services_stopped else self._stop_services()
        self._status = "off" if error is None and cleanup_error is None else "failed"
        self._error = error or cleanup_error

    def _stop_services(self) -> str | None:
        try:
            result = self._run_command(
                self.stop_command,
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return f"Office service shutdown failed: {type(error).__name__}"
        self._reap_orphans()
        if result.returncode != 0:
            return f"Office service shutdown exited {result.returncode}"
        self._services_stopped = True
        return None

    def _reap_orphans(self) -> None:
        while True:
            try:
                pid, _status = self._waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return

    def _ready(self) -> bool:
        try:
            with self._urlopen(self.ready_url, timeout=2) as response:  # type: ignore[attr-defined] # noqa: S310
                return bool(response.status == 200)
        except (urllib.error.URLError, TimeoutError):
            return False

    def status(self) -> Mapping[str, object]:
        return {
            "status": self._status,
            "revision": self._revision,
            "attempts": self._attempts,
            "child": self._process is not None and self._process.poll() is None,
            "error": self._error,
        }


def run(
    lifecycle: OfficeLifecycle,
    client: OfficeClient,
    interval: float,
    stale_seconds: float,
    sleep: Callable[[float], None],
) -> None:
    last_good_at: float | None = None
    while True:
        try:
            snapshot = client.fetch()
            last_good_at = time.monotonic()
            lifecycle.reconcile(snapshot)
        except ValueError:
            if last_good_at is None or time.monotonic() - last_good_at >= stale_seconds:
                lifecycle.reconcile(None)
        sleep(interval)


def main() -> None:
    command = sys.argv[1:]
    lifecycle = OfficeLifecycle(
        command,
        (os.environ.get("FDRIVE_OFFICE_STOP_COMMAND", "/fdrive/onlyoffice-stop.sh"),),
        os.environ.get("FDRIVE_OFFICE_READY_URL", "http://127.0.0.1/hosting/discovery"),
        retry_after_seconds=parse_retry_after(os.environ.get("FDRIVE_RUNTIME_RETRY_AFTER_SECONDS", "")),
    )
    client = OfficeClient(
        os.environ.get("FDRIVE_OFFICE_SETTINGS_URL", DEFAULT_OFFICE_URL),
        os.environ.get("FDRIVE_WORKER_TOKEN", ""),
    )
    serve_status(lifecycle, int(os.environ.get("FDRIVE_RUNTIME_PORT", "8099")))
    interval = float(os.environ.get("FDRIVE_RUNTIME_POLL_SECONDS", "3"))
    stale_seconds = float(os.environ.get("FDRIVE_RUNTIME_STALE_SECONDS", "9"))
    if interval <= 0 or stale_seconds < interval:
        raise ValueError("runtime polling intervals must be positive and stale window >= poll interval")

    def stop_handler(_signum: int, _frame: object) -> None:
        lifecycle.stop(None)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    try:
        run(lifecycle, client, interval, stale_seconds, time.sleep)
    except KeyboardInterrupt:
        lifecycle.stop(None)


if __name__ == "__main__":
    main()
