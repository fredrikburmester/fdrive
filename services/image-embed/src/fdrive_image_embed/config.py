"""Environment-derived configuration. Reading `os.environ` is I/O by nature, so
this class is a thin shim; the one bit of actual parsing logic (`_parse_threads`)
is pure and tested directly. Device *resolution* (turning "auto" into "cpu" or
"cuda") is deliberately not done here: `device.py` does that without importing
torch, so this module stays torch-free too.
"""

from __future__ import annotations

import os

DEFAULT_MODEL = "google/siglip2-large-patch16-256"
DEFAULT_PORT = 8012
DEFAULT_BATCH_SIZE = 8
DEFAULT_DEVICE = "auto"
DEFAULT_HF_HOME = "/models"


def _parse_threads(raw: str | None) -> int | None:
    """`IMAGE_EMBED_THREADS` unset (or blank, matching how compose passthroughs
    like `${VAR:-}` always set the env var) means "torch default": `None`. An
    unparsable value falls back to the same default rather than crashing
    startup over a typo."""
    if raw is None or not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        return None


class Config:
    def __init__(self) -> None:
        self.model_id = os.environ.get("IMAGE_EMBED_MODEL", DEFAULT_MODEL)
        self.port = int(os.environ.get("IMAGE_EMBED_PORT", str(DEFAULT_PORT)))
        self.batch_size = int(os.environ.get("IMAGE_EMBED_BATCH_SIZE", str(DEFAULT_BATCH_SIZE)))
        self.device = os.environ.get("IMAGE_EMBED_DEVICE", DEFAULT_DEVICE)
        self.threads = _parse_threads(os.environ.get("IMAGE_EMBED_THREADS"))
        self.hf_home = os.environ.get("HF_HOME", DEFAULT_HF_HOME)
