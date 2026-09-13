"""Stdout plus optional bounded diagnostic files on a persistent volume."""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from logging.handlers import RotatingFileHandler

_lock = threading.Lock()
_handler: RotatingFileHandler | None = None
_configured = False


def log(message: str) -> None:
    global _handler, _configured
    line = f"{datetime.now().astimezone().isoformat(timespec='seconds')} {message}"
    print(line, flush=True)
    with _lock:
        if not _configured:
            _configured = True
            directory = os.environ.get("INDEXER_LOG_DIR")
            if directory:
                try:
                    os.makedirs(directory, exist_ok=True)
                    _handler = RotatingFileHandler(
                        os.path.join(directory, "indexer.log"), maxBytes=10 * 1024 * 1024, backupCount=4, encoding="utf-8"
                    )
                except OSError as exc:
                    print(f"Persistent indexer logs unavailable: {exc}", flush=True)
        if _handler is not None:
            _handler.emit(logging.LogRecord("indexer", logging.INFO, "", 0, line, (), None))
