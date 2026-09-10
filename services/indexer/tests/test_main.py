from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from psycopg.types.json import Json

from fdrive_indexer import db, main
from fdrive_indexer.config import Config
from fdrive_indexer.features import FEATURES_KEY
from fdrive_indexer.settings import Settings


def _wait_until(predicate: object, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(interval)
    return predicate()  # type: ignore[operator]


def test_build_context_upserts_root_and_wires_extractor(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    assert ctx.name == "sftpgo"
    assert ctx.root_id > 0
    assert ctx.abs_path == str(tmp_path)
    assert ctx.extractor.root == "sftpgo"
    assert ctx.feature_configuration().values.indexer_enabled is False


def test_refresh_features_requires_explicit_persisted_selection(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    values = {
        "thumbnails": False,
        "textSearch": True,
        "searchOcr": False,
        "semanticSearch": False,
        "imageSearch": False,
        "pdfOcr": False,
    }
    with ctx.conn().cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            (FEATURES_KEY, Json({"version": 1, "revision": 2, "values": values})),
        )

    assert main.refresh_features(ctx) is True
    assert ctx.feature_configuration().revision == 2
    assert ctx.feature_configuration().values.text_search is True


def test_refresh_settings_updates_ctx_and_logs_changes(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    import psycopg.types.json

    with ctx.conn().cursor() as cur:
        cur.execute(
            'INSERT INTO "app"."settings" (key, value) VALUES (%s, %s)',
            ("indexer.workers", psycopg.types.json.Json(7)),
        )
    logs: list[str] = []
    monkeypatch.setattr(main, "log", logs.append)
    main.refresh_settings(ctx)
    assert ctx.settings.workers == 7
    assert any("settings changed" in line for line in logs)


def test_refresh_settings_no_change_does_not_log(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    logs: list[str] = []
    monkeypatch.setattr(main, "log", logs.append)
    main.refresh_settings(ctx)
    assert logs == []


def test_run_root_loops_scanning_until_woken(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    ctx.settings = Settings(
        scan_interval_seconds=1,
        workers=ctx.settings.workers,
        text_exclude_globs=ctx.settings.text_exclude_globs,
        ocr_image_globs=ctx.settings.ocr_image_globs,
        tesseract_langs=ctx.settings.tesseract_langs,
    )
    calls = {"n": 0}

    def fake_scan_once(_ctx: object) -> dict[str, int]:
        calls["n"] += 1
        return {"seen": 0, "changed": 0, "deleted": 0, "errors": 0}

    monkeypatch.setattr(main, "scan_once", fake_scan_once)
    monkeypatch.setattr(main, "refresh_settings", lambda _ctx: None)
    monkeypatch.setattr(main, "start_watcher", lambda *a, **k: None)

    watchers: dict[str, object | None] = {}
    wake_events: dict[str, threading.Event] = {}
    thread = threading.Thread(target=main.run_root, args=(ctx, watchers, wake_events), daemon=True)
    thread.start()
    assert _wait_until(lambda: "sftpgo" in wake_events)
    assert _wait_until(lambda: calls["n"] >= 1)
    wake_events["sftpgo"].set()
    assert _wait_until(lambda: calls["n"] >= 2)


def test_run_root_does_not_rescan_at_feature_refresh_cadence(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    ctx.settings = Settings(60, ctx.settings.workers, (), (), "eng")
    calls = {"n": 0}
    monkeypatch.setattr(main, "scan_once", lambda _ctx: calls.__setitem__("n", calls["n"] + 1) or {})
    monkeypatch.setattr(main, "refresh_settings", lambda _ctx: None)
    monkeypatch.setattr(main, "start_watcher", lambda *a, **k: None)

    watchers: dict[str, object | None] = {}
    wake_events: dict[str, threading.Event] = {}
    threading.Thread(target=main.run_root, args=(ctx, watchers, wake_events), daemon=True).start()
    assert _wait_until(lambda: calls["n"] == 1)
    time.sleep(0.2)
    assert calls["n"] == 1


def test_run_root_survives_scan_crash(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    ctx.settings = Settings(1, ctx.settings.workers, (), (), "eng")

    calls = {"n": 0}

    def flaky_scan_once(_ctx: object) -> dict[str, int]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return {"seen": 0, "changed": 0, "deleted": 0, "errors": 0}

    monkeypatch.setattr(main, "scan_once", flaky_scan_once)
    monkeypatch.setattr(main, "refresh_settings", lambda _ctx: None)
    monkeypatch.setattr(main, "start_watcher", lambda *a, **k: None)

    watchers: dict[str, object | None] = {}
    wake_events: dict[str, threading.Event] = {}
    thread = threading.Thread(target=main.run_root, args=(ctx, watchers, wake_events), daemon=True)
    thread.start()
    assert _wait_until(lambda: calls["n"] >= 2)


def test_run_root_wakes_on_watcher_overflow(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INDEX_ROOTS", f"sftpgo={tmp_path}")
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    cfg = Config()
    ctx = main.build_context(cfg, postgres_dsn, "sftpgo", str(tmp_path))
    # scan_interval_seconds=0 makes the loop spin fast (nothing ever sets the
    # per-root wake event), so a short real-time sleep is enough to exercise the
    # watcher-overflow branch both set and cleared many times deterministically.
    ctx.settings = Settings(0, ctx.settings.workers, (), (), "eng")

    class FakeWatcher:
        def __init__(self) -> None:
            self.wake = threading.Event()

    fake_watcher = FakeWatcher()
    calls = {"n": 0}

    def fake_scan_once(_ctx: object) -> dict[str, int]:
        calls["n"] += 1
        if calls["n"] % 2 == 1:
            fake_watcher.wake.set()
        return {"seen": 0, "changed": 0, "deleted": 0, "errors": 0}

    monkeypatch.setattr(main, "scan_once", fake_scan_once)
    monkeypatch.setattr(main, "refresh_settings", lambda _ctx: None)
    monkeypatch.setattr(main, "start_watcher", lambda *a, **k: fake_watcher)

    watchers: dict[str, object | None] = {}
    wake_events: dict[str, threading.Event] = {}
    thread = threading.Thread(target=main.run_root, args=(ctx, watchers, wake_events), daemon=True)
    thread.start()
    assert _wait_until(lambda: calls["n"] >= 20, timeout=5)


def test_main_stays_live_when_no_roots_configured(postgres_dsn: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", postgres_dsn)
    monkeypatch.delenv("INDEX_ROOTS", raising=False)
    served: dict[str, object] = {}
    monkeypatch.setattr(main.uvicorn, "run", lambda app, **_kwargs: served.setdefault("app", app))
    main.main()
    assert served["app"].state.server_state.contexts == {}  # type: ignore[attr-defined]


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
    monkeypatch.setenv("EMBED_URL", "http://embed.invalid")
    monkeypatch.setenv("INDEXER_PORT", "0")

    monkeypatch.setattr(main, "scan_once", lambda ctx: {"seen": 0, "changed": 0, "deleted": 0, "errors": 0})

    served: dict[str, object] = {}

    def fake_uvicorn_run(app: object, **kwargs: object) -> None:
        served["app"] = app
        served["kwargs"] = kwargs

    monkeypatch.setattr(main.uvicorn, "run", fake_uvicorn_run)

    main.main()

    assert "app" in served
    assert served["kwargs"]["port"] == 0  # type: ignore[index]


def test_shared_connection_reopens_after_postgres_goes_away(postgres_dsn: str) -> None:
    first = db.connect(postgres_dsn)
    shared = main.SharedConnection(postgres_dsn, first)
    assert shared.get() is first

    # Simulate the `db` container being recreated under a live indexer: the
    # cached socket is dead, and the next handler call must get a fresh one.
    first.close()
    second = shared.get()
    assert second is not first
    assert db.read_schema_version(second) is not None
    assert shared.get() is second


def test_shared_connection_fails_fast_when_postgres_is_still_down(postgres_dsn: str) -> None:
    first = db.connect(postgres_dsn)
    shared = main.SharedConnection("postgresql://fdrive:x@127.0.0.1:1/fdrive?connect_timeout=1", first)
    first.close()
    with pytest.raises(RuntimeError, match="could not connect to postgres"):
        shared.get()
