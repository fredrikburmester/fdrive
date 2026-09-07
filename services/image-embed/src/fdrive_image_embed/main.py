"""Entrypoint: resolve config, resolve the actual device, start loading the
model on a background thread (so `/health` answers immediately with
`"loading"`), and serve the internal HTTP API. `python -m
fdrive_image_embed.main`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import datetime

import uvicorn

from .config import Config
from .device import resolve_device
from .server import ModelHolder, ServerState, create_app
from .siglip import load_embedder


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def cuda_available() -> bool:  # pragma: no cover - requires torch; production only
    import torch

    return bool(torch.cuda.is_available())


def load_in_background(
    holder: ModelHolder,
    model_id: str,
    device: str,
    threads: int | None,
    batch_size: int,
    log_fn: Callable[[str], None],
) -> None:
    """Loads the model and, on success, publishes it through `holder` so
    `/health` flips to `"ok"` and the embed endpoints stop reporting 503. A
    bad model id or a download failure is logged and leaves the process
    serving `"loading"` forever rather than crashing (matching how the other
    sidecars degrade rather than exit)."""
    try:
        embedder = load_embedder(model_id, device, threads, batch_size)
    except Exception as e:  # noqa: BLE001 - a bad model id must never crash the process
        log_fn(f"model load failed: {type(e).__name__}: {e}")
        return
    holder.set(embedder)
    log_fn(f"model loaded: {embedder.model_id} dim={embedder.dim} device={device}")


def main() -> None:
    cfg = Config()
    device = resolve_device(cfg.device, cuda_available)
    holder = ModelHolder()

    thread = threading.Thread(
        target=load_in_background,
        args=(holder, cfg.model_id, device, cfg.threads, cfg.batch_size, log),
        daemon=True,
        name="image-embed-loader",
    )
    thread.start()

    state = ServerState(model_id=cfg.model_id, device=device, holder=holder)
    app = create_app(state)
    log(f"image-embed up. model={cfg.model_id} device={device} port={cfg.port}")
    uvicorn.run(app, host="0.0.0.0", port=cfg.port, log_level="warning")  # noqa: S104 - compose-network only


if __name__ == "__main__":
    main()
