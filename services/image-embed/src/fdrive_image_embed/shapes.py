"""Pure shaping of the `/health` and embed response bodies from data the I/O
layer (`server.py`, `siglip.py`) already fetched or computed. No querying,
no model, no HTTP here, matching `services/ocr`'s `stats.py`.
"""

from __future__ import annotations

from typing import Any


def shape_health(loaded: bool, model_id: str, dim: int | None, device: str) -> dict[str, Any]:
    """`dim` is only ever non-null once `loaded` is true: the loaded model's
    own reported dimension, never the configured target's guess."""
    return {
        "status": "ok" if loaded else "loading",
        "model": model_id,
        "dim": dim if loaded else None,
        "device": device,
    }


def shape_embed_response(model_id: str, dim: int, embeddings: list[list[float]]) -> dict[str, Any]:
    return {"model": model_id, "dim": dim, "embeddings": embeddings}
