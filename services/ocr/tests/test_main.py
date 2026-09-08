from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from fdrive_ocr import db, main
from fdrive_ocr.features import FeatureConfiguration, FeatureValues
from fdrive_ocr.server import RunLock
from fdrive_ocr.settings import Settings

FIXED_NOW = datetime(2026, 1, 1, 1, 0, tzinfo=UTC)
DEFAULT_SETTINGS = Settings(hour=3, langs="swe+eng", exclude_globs=(), max_mb=200, keep_originals=True)


class StopLoop(Exception):
    """Raised by a fake `sleep` to break `scheduler_loop`'s `while True` after a
    bounded number of iterations, so the test does not need a real thread."""


def test_log_prints_a_timestamped_line(capsys: pytest.CaptureFixture[str]) -> None:
    main.log("hello")
    out = capsys.readouterr().out
    assert "hello" in out


def test_build_targets_upserts_roots(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        targets = main.build_targets(conn, {"sftpgo": str(tmp_path), "photos": str(tmp_path)})
        assert {t.name for t in targets} == {"sftpgo", "photos"}
        assert all(t.root_id > 0 for t in targets)
    finally:
        conn.close()


# -- run_once ---------------------------------------------------------------------


def test_run_once_runs_a_pass_and_releases_the_lock(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    root_id = db.upsert_root(conn, "sftpgo")
    conn.close()
    target_dir = tmp_path / "root"
    target_dir.mkdir()
    (target_dir / "a.pdf").write_bytes(b"HASTEXT\n")
    from fdrive_ocr.runner import RootTarget

    targets = [RootTarget(name="sftpgo", root_id=root_id, abs_path=str(target_dir))]
    lock = RunLock()
    logs: list[str] = []
    ran = main.run_once(
        lock, lambda: db.connect(postgres_dsn), targets, DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, logs.append
    )
    assert ran is True
    assert lock.running is False
    assert any("OCR pass done" in line for line in logs)


def test_run_once_applies_include_globs(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    root_id = db.upsert_root(conn, "sftpgo")
    conn.close()
    target_dir = tmp_path / "root"
    (target_dir / "fredrik").mkdir(parents=True)
    (target_dir / "fredrik" / "in-scope.pdf").write_bytes(b"HASTEXT\n")
    (target_dir / "alice").mkdir()
    (target_dir / "alice" / "out-of-scope.pdf").write_bytes(b"HASTEXT\n")
    from fdrive_ocr.runner import RootTarget

    targets = [RootTarget(name="sftpgo", root_id=root_id, abs_path=str(target_dir))]
    lock = RunLock()
    logs: list[str] = []
    main.run_once(
        lock,
        lambda: db.connect(postgres_dsn),
        targets,
        DEFAULT_SETTINGS,
        str(tmp_path / "state"),
        30,
        2,
        logs.append,
        include_globs=("sftpgo/fredrik/**",),
    )
    conn = db.connect(postgres_dsn)
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT path, status FROM "idx"."ocr_log" WHERE root_id = %s', (root_id,))
            statuses = dict(cur.fetchall())
    finally:
        conn.close()
    assert statuses[str(Path("alice") / "out-of-scope.pdf")] == "excluded"
    assert statuses[str(Path("fredrik") / "in-scope.pdf")] == "has_text"


def test_run_once_skips_when_already_running(postgres_dsn: str, tmp_path: Path) -> None:
    lock = RunLock()
    lock.try_acquire()
    logs: list[str] = []
    ran = main.run_once(lock, lambda: db.connect(postgres_dsn), [], DEFAULT_SETTINGS, str(tmp_path), 30, 2, logs.append)
    assert ran is False
    assert any("skipped" in line for line in logs)
    lock.release()


def test_run_once_does_not_rewrite_when_managed_pdf_ocr_is_disabled(postgres_dsn: str, tmp_path: Path) -> None:
    logs: list[str] = []
    assert (
        main.run_once(
            RunLock(),
            lambda: db.connect(postgres_dsn),
            [],
            DEFAULT_SETTINGS,
            str(tmp_path),
            30,
            2,
            logs.append,
            feature_defaults=FeatureConfiguration(0, FeatureValues(True, True, False, True, False, True)),
            features_managed=True,
        )
        is False
    )
    assert any("PDF OCR disabled" in line for line in logs)


def test_run_once_logs_and_releases_lock_on_crash(postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(main, "run_pass", boom)
    lock = RunLock()
    logs: list[str] = []
    ran = main.run_once(lock, lambda: db.connect(postgres_dsn), [], DEFAULT_SETTINGS, str(tmp_path), 30, 2, logs.append)
    assert ran is True
    assert lock.running is False
    assert any("crashed" in line for line in logs)


# -- scheduler_loop -----------------------------------------------------------------


def test_scheduler_loop_runs_on_start_then_reschedules(
    postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_calls: list[bool] = []

    def fake_run_once(*args: object, **kwargs: object) -> bool:
        run_calls.append(True)
        return True

    monkeypatch.setattr(main, "run_once", fake_run_once)

    sleep_calls = {"n": 0}

    def fake_sleep(_seconds: float) -> None:
        sleep_calls["n"] += 1
        if sleep_calls["n"] >= 2:
            raise StopLoop()

    with pytest.raises(StopLoop):
        main.scheduler_loop(
            RunLock(),
            lambda: db.connect(postgres_dsn),
            [],
            DEFAULT_SETTINGS,
            str(tmp_path),
            30,
            2,
            run_on_start=True,
            log_fn=lambda _m: None,
            now=lambda: FIXED_NOW,
            sleep=fake_sleep,
        )
    # Polling before the nightly target must not start another source-writing pass.
    assert len(run_calls) == 1


def test_scheduler_loop_skips_initial_run_when_disabled(
    postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_calls: list[bool] = []
    monkeypatch.setattr(main, "run_once", lambda *a, **k: run_calls.append(True) or True)

    def fake_sleep(_seconds: float) -> None:
        raise StopLoop()

    with pytest.raises(StopLoop):
        main.scheduler_loop(
            RunLock(),
            lambda: db.connect(postgres_dsn),
            [],
            DEFAULT_SETTINGS,
            str(tmp_path),
            30,
            2,
            run_on_start=False,
            log_fn=lambda _m: None,
            now=lambda: FIXED_NOW,
            sleep=fake_sleep,
        )
    assert run_calls == []


def test_scheduler_loop_re_reads_settings_for_the_hour(
    postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import psycopg.types.json

    conn = db.connect(postgres_dsn)
    with conn.cursor() as cur:
        cur.execute('INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)', ("ocr.hour", psycopg.types.json.Json(7)))
    conn.close()

    monkeypatch.setattr(main, "run_once", lambda *a, **k: True)
    seen_targets: list[datetime] = []

    real_next_run_at = main.next_run_at

    def spy_next_run_at(now: datetime, hour: int) -> datetime:
        target = real_next_run_at(now, hour)
        seen_targets.append(target)
        return target

    monkeypatch.setattr(main, "next_run_at", spy_next_run_at)

    def fake_sleep(_seconds: float) -> None:
        raise StopLoop()

    with pytest.raises(StopLoop):
        main.scheduler_loop(
            RunLock(),
            lambda: db.connect(postgres_dsn),
            [],
            DEFAULT_SETTINGS,
            str(tmp_path),
            30,
            2,
            run_on_start=False,
            log_fn=lambda _m: None,
            now=lambda: FIXED_NOW,
            sleep=fake_sleep,
        )
    assert seen_targets[0].hour == 7


# -- main -----------------------------------------------------------------------


def test_main_stays_live_when_no_roots_configured(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.delenv("INDEX_ROOTS", raising=False)

    class NoopThread:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def start(self) -> None:
            pass

    served: dict[str, object] = {}
    monkeypatch.setattr(main.threading, "Thread", NoopThread)
    monkeypatch.setattr(main.uvicorn, "run", lambda app, **_kwargs: served.setdefault("app", app))
    main.main()
    assert served["app"].state.server_state.targets == []  # type: ignore[attr-defined]


def test_main_exits_when_schema_never_ready(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setattr(db, "wait_for_schema_version", lambda *a, **k: None)
    with pytest.raises(SystemExit) as exc_info:
        main.main()
    assert exc_info.value.code == 1


def test_main_wires_everything_and_serves(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("OCR_PORT", "0")
    monkeypatch.setenv("OCR_RUN_ON_START", "false")
    monkeypatch.setenv("STATE_DIR", str(tmp_path / "state"))

    served: dict[str, object] = {}

    def fake_uvicorn_run(app: object, **kwargs: object) -> None:
        served["app"] = app
        served["kwargs"] = kwargs

    monkeypatch.setattr(main.uvicorn, "run", fake_uvicorn_run)

    main.main()

    assert "app" in served
    assert served["kwargs"]["port"] == 0  # type: ignore[index]
    state = served["app"].state.server_state  # type: ignore[attr-defined]
    assert state.schema_ready() is True
    assert state.now().tzinfo is not None
