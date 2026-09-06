"""Entrypoint: wait for the schema handshake, wire up one `RootContext` per
configured root, start each root's watcher and scan loop, and serve the internal
HTTP API. `python -m fdrive_indexer.main`.
"""

from __future__ import annotations

import sys
import threading

import uvicorn

from . import db
from .chunking import normalize as normalize_text
from .config import Config
from .extract import Extractor
from .indexer import RootContext, log, scan_once, start_watcher, wait_for_embed
from .server import ServerState, create_app
from .settings import diff_changed, resolve_settings

EXPECTED_SCHEMA_VERSION = 1


def build_context(cfg: Config, conn_dsn: str, name: str, abs_path: str) -> RootContext:
    conn = db.connect(conn_dsn)
    root_id = db.upsert_root(conn, name)
    settings = cfg.default_settings()
    extractor = Extractor(
        root=name,
        text_max_bytes=cfg.text_max_bytes,
        image_max_bytes=cfg.image_max_bytes,
        max_pdf_pages=cfg.max_pdf_pages,
        plain_text_cap=cfg.plain_text_cap,
        tesseract_langs=settings.tesseract_langs,
        ocr_image_globs=list(settings.ocr_image_globs),
        tika_url=cfg.tika_url,
        normalize=normalize_text,
    )
    ctx = RootContext(name=name, root_id=root_id, abs_path=abs_path, cfg=cfg, settings=settings, extractor=extractor)
    ctx.local.conn = conn
    return ctx


def refresh_settings(ctx: RootContext) -> None:
    raw = db.read_settings(ctx.conn())
    new_settings = resolve_settings(raw, ctx.cfg.default_settings())
    changed = diff_changed(ctx.settings, new_settings)
    if changed:
        log(f"[{ctx.name}] settings changed: {', '.join(changed)}")
    ctx.settings = new_settings
    ctx.extractor = Extractor(
        root=ctx.name,
        text_max_bytes=ctx.cfg.text_max_bytes,
        image_max_bytes=ctx.cfg.image_max_bytes,
        max_pdf_pages=ctx.cfg.max_pdf_pages,
        plain_text_cap=ctx.cfg.plain_text_cap,
        tesseract_langs=new_settings.tesseract_langs,
        ocr_image_globs=list(new_settings.ocr_image_globs),
        tika_url=ctx.cfg.tika_url,
        normalize=normalize_text,
    )


def run_root(ctx: RootContext, watchers: dict[str, object | None], wake_events: dict[str, threading.Event]) -> None:
    wake = threading.Event()
    wake_events[ctx.name] = wake
    watchers[ctx.name] = start_watcher(ctx, ctx.settings.workers, ctx.cfg.watch_debounce)
    watcher = watchers[ctx.name]
    while True:
        try:
            refresh_settings(ctx)
            scan_once(ctx)
        except Exception as e:  # noqa: BLE001
            log(f"[{ctx.name}] scan crashed: {type(e).__name__}: {e}")
        timeout = ctx.settings.scan_interval_seconds
        fired = wake.wait(timeout=timeout)
        wake.clear()
        watcher_wake = getattr(watcher, "wake", None)
        if watcher_wake is not None and watcher_wake.is_set():
            watcher_wake.clear()
            fired = True
        if not fired:
            continue  # normal interval elapsed, loop again


def main() -> None:
    cfg = Config()
    if not cfg.roots:
        log("no INDEX_ROOTS configured; nothing to do")
        sys.exit(1)

    bootstrap_conn = db.connect(cfg.database_url)
    log(f"waiting for idx.schema_version = {EXPECTED_SCHEMA_VERSION} (timeout {cfg.schema_wait_seconds}s)")
    version = db.wait_for_schema_version(bootstrap_conn, EXPECTED_SCHEMA_VERSION, cfg.schema_wait_seconds, log)
    if version is None:
        sys.exit(1)
    log(f"schema ready at version {version}")

    wait_for_embed(cfg.embed_url)

    contexts = {name: build_context(cfg, cfg.database_url, name, abs_path) for name, abs_path in cfg.roots.items()}
    watchers: dict[str, object | None] = {}
    wake_events: dict[str, threading.Event] = {}

    for ctx in contexts.values():
        thread = threading.Thread(target=run_root, args=(ctx, watchers, wake_events), daemon=True, name=f"root-{ctx.name}")
        thread.start()

    state = ServerState(
        contexts=contexts,
        watchers=watchers,
        wake_events=wake_events,
        conn_factory=lambda: bootstrap_conn,
        schema_version=lambda: db.read_schema_version(bootstrap_conn),
    )
    app = create_app(state)
    log(f"indexer up. roots={list(cfg.roots)} port={cfg.indexer_port}")
    uvicorn.run(app, host="0.0.0.0", port=cfg.indexer_port, log_level="warning")  # noqa: S104 - compose-network only


if __name__ == "__main__":
    main()
