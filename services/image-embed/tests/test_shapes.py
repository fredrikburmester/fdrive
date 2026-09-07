from __future__ import annotations

from fdrive_image_embed.shapes import shape_embed_response, shape_health


def test_shape_health_while_loading() -> None:
    assert shape_health(False, "google/siglip2-large-patch16-256", None, "cpu") == {
        "status": "loading",
        "model": "google/siglip2-large-patch16-256",
        "dim": None,
        "device": "cpu",
    }


def test_shape_health_once_loaded() -> None:
    assert shape_health(True, "google/siglip2-large-patch16-256", 1024, "cuda") == {
        "status": "ok",
        "model": "google/siglip2-large-patch16-256",
        "dim": 1024,
        "device": "cuda",
    }


def test_shape_health_ignores_a_stray_dim_while_loading() -> None:
    # Defensive: even if a caller passed a dim while loaded=False, the shaped
    # body must still report null, matching the fixed contract.
    assert shape_health(False, "m", 1024, "cpu")["dim"] is None


def test_shape_embed_response() -> None:
    assert shape_embed_response("m", 4, [[0.1, 0.2, 0.3, 0.4]]) == {
        "model": "m",
        "dim": 4,
        "embeddings": [[0.1, 0.2, 0.3, 0.4]],
    }
