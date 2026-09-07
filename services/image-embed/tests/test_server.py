from __future__ import annotations

import math

from conftest import UNDECODABLE, FakeEmbedder
from starlette.testclient import TestClient

from fdrive_image_embed import server


def _make_state(loaded: bool = True, device: str = "cpu") -> server.ServerState:
    holder = server.ModelHolder()
    if loaded:
        holder.set(FakeEmbedder())
    return server.ServerState(model_id="google/siglip2-large-patch16-256", device=device, holder=holder)


def _client(loaded: bool = True, device: str = "cpu") -> TestClient:
    return TestClient(server.create_app(_make_state(loaded=loaded, device=device)))


def _image_file(name: str, content: bytes = b"fake-image-bytes") -> tuple[str, tuple[str, bytes, str]]:
    return ("images", (name, content, "image/png"))


# -- /health ------------------------------------------------------------------------


def test_health_reports_loading_with_no_dim() -> None:
    client = _client(loaded=False)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "loading"
    assert body["model"] == "google/siglip2-large-patch16-256"
    assert body["dim"] is None
    assert body["device"] == "cpu"


def test_health_reports_ok_with_the_loaded_models_dim() -> None:
    client = _client(loaded=True, device="cuda")
    resp = client.get("/health")
    body = resp.json()
    assert body["status"] == "ok"
    assert body["model"] == "fake/model"
    assert body["dim"] == 4
    assert body["device"] == "cuda"


# -- /embed/image -------------------------------------------------------------------


def test_embed_image_returns_normalized_vectors_in_order() -> None:
    client = _client()
    resp = client.post("/embed/image", files=[_image_file("a.png", b"aaa"), _image_file("b.png", b"bbbbb")])
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "fake/model"
    assert body["dim"] == 4
    assert len(body["embeddings"]) == 2
    for vector in body["embeddings"]:
        assert math.isclose(math.sqrt(sum(x * x for x in vector)), 1.0, rel_tol=1e-6)


def test_embed_image_503_before_model_loaded() -> None:
    client = _client(loaded=False)
    resp = client.post("/embed/image", files=[_image_file("a.png")])
    assert resp.status_code == 503
    assert resp.text == server.MODEL_NOT_LOADED_MESSAGE


def test_embed_image_400_when_no_images_given() -> None:
    client = _client()
    resp = client.post("/embed/image", data={"unrelated": "x"})
    assert resp.status_code == 400


def test_embed_image_413_over_the_image_count_limit() -> None:
    client = _client()
    files = [_image_file(f"{i}.png") for i in range(33)]
    resp = client.post("/embed/image", files=files)
    assert resp.status_code == 413


def test_embed_image_413_over_the_size_limit() -> None:
    client = _client()
    oversized = b"x" * (8 * 1024 * 1024 + 1)
    resp = client.post("/embed/image", files=[_image_file("big.png", oversized)])
    assert resp.status_code == 413


def test_embed_image_400_on_undecodable_bytes() -> None:
    client = _client()
    resp = client.post("/embed/image", files=[_image_file("bad.png", UNDECODABLE)])
    assert resp.status_code == 400


def test_embed_image_400_when_images_part_is_not_a_file() -> None:
    client = _client()
    resp = client.post("/embed/image", data={"images": "not-a-file"})
    assert resp.status_code == 400


# -- /embed/text --------------------------------------------------------------------


def test_embed_text_returns_normalized_vectors_in_order() -> None:
    client = _client()
    resp = client.post("/embed/text", json={"inputs": ["blue chair", "a dog"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "fake/model"
    assert body["dim"] == 4
    assert len(body["embeddings"]) == 2
    for vector in body["embeddings"]:
        assert math.isclose(math.sqrt(sum(x * x for x in vector)), 1.0, rel_tol=1e-6)


def test_embed_text_503_before_model_loaded() -> None:
    client = _client(loaded=False)
    resp = client.post("/embed/text", json={"inputs": ["blue chair"]})
    assert resp.status_code == 503
    assert resp.text == server.MODEL_NOT_LOADED_MESSAGE


def test_embed_text_400_on_invalid_json() -> None:
    client = _client()
    resp = client.post("/embed/text", content=b"not json", headers={"content-type": "application/json"})
    assert resp.status_code == 400


def test_embed_text_400_when_inputs_missing() -> None:
    client = _client()
    resp = client.post("/embed/text", json={})
    assert resp.status_code == 400


def test_embed_text_413_over_the_text_count_limit() -> None:
    client = _client()
    resp = client.post("/embed/text", json={"inputs": ["x"] * 65})
    assert resp.status_code == 413


def test_embed_text_413_over_the_length_limit() -> None:
    client = _client()
    resp = client.post("/embed/text", json={"inputs": ["x" * 513]})
    assert resp.status_code == 413
