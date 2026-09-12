from __future__ import annotations

import asyncio
import math
import threading

import httpx
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


class BlockingEmbedder(FakeEmbedder):
    """Blocks inference so tests can observe event-loop and concurrency behavior."""

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def embed_images(self, images: list[bytes]) -> list[list[float]]:
        self._block()
        return super().embed_images(images)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self._block()
        return super().embed_texts(texts)

    def _block(self) -> None:
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.started.set()
        try:
            if not self.release.wait(timeout=2):
                raise RuntimeError("test timed out waiting to release inference")
        finally:
            with self._lock:
                self.active -= 1


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


def test_health_stays_responsive_and_model_inference_is_serialized() -> None:
    embedder = BlockingEmbedder()
    holder = server.ModelHolder()
    holder.set(embedder)
    state = server.ServerState(model_id=embedder.model_id, device="cpu", holder=holder)
    app = server.create_app(state)

    async def exercise() -> None:
        fallback_release = threading.Timer(1, embedder.release.set)
        fallback_release.start()
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                image_task = asyncio.create_task(
                    client.post("/embed/image", files=[_image_file("a.png", b"aaa")])
                )
                text_task: asyncio.Task[httpx.Response] | None = None
                try:
                    assert await asyncio.to_thread(embedder.started.wait, 1)

                    text_task = asyncio.create_task(client.post("/embed/text", json={"inputs": ["blue chair"]}))
                    async with asyncio.timeout(0.5):
                        while state.inference_limiter.statistics().tasks_waiting != 1:
                            await asyncio.sleep(0)
                    health_response = await client.get("/health")

                    assert health_response.status_code == 200
                    assert health_response.json()["status"] == "ok"
                    assert not embedder.release.is_set()
                    assert embedder.max_active == 1
                finally:
                    embedder.release.set()
                    tasks = [image_task] if text_task is None else [image_task, text_task]
                    await asyncio.gather(*tasks, return_exceptions=True)

                assert text_task is not None
                image_response = image_task.result()
                text_response = text_task.result()
                assert image_response.status_code == 200
                assert text_response.status_code == 200
                for response in (image_response, text_response):
                    vector = response.json()["embeddings"][0]
                    assert math.isclose(math.sqrt(sum(x * x for x in vector)), 1.0, rel_tol=1e-6)
        finally:
            embedder.release.set()
            fallback_release.cancel()

    asyncio.run(exercise())


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


def test_oversized_upload_is_rejected_before_read_and_closed(monkeypatch) -> None:
    from starlette.datastructures import UploadFile

    reads: list[int] = []
    closed: list[bool] = []
    original_read = UploadFile.read
    original_close = UploadFile.close

    async def read(self, size=-1):
        reads.append(size)
        return await original_read(self, size)

    async def close(self):
        closed.append(True)
        await original_close(self)

    monkeypatch.setattr(UploadFile, "read", read)
    monkeypatch.setattr(UploadFile, "close", close)
    response = _client().post("/embed/image", files=[_image_file("huge.png", b"x" * (server.MAX_IMAGE_BYTES + 1))])
    assert response.status_code == 413
    assert reads == []
    assert closed


def test_upload_reader_is_bounded_even_without_parser_size(monkeypatch) -> None:
    from starlette.datastructures import UploadFile

    original_init = UploadFile.__init__

    def init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.size = None

    monkeypatch.setattr(UploadFile, "__init__", init)
    original_read = UploadFile.read
    reads: list[int] = []

    async def read(self, size=-1):
        reads.append(size)
        return await original_read(self, size)

    monkeypatch.setattr(UploadFile, "read", read)
    response = _client().post("/embed/image", files=[_image_file("unknown-size.png", b"x" * (server.MAX_IMAGE_BYTES + 1))])
    assert response.status_code == 413
    assert reads == [server.MAX_IMAGE_BYTES + 1]
