from __future__ import annotations

import httpx
import pytest

from fdrive_indexer import image_embed


def test_parse_health_ok() -> None:
    body = {"status": "ok", "model": "google/siglip2-large-patch16-256", "dim": 1024, "device": "cpu"}
    health = image_embed.parse_health(body)
    assert health == image_embed.ImageEmbedHealth(
        status="ok", model="google/siglip2-large-patch16-256", dim=1024, device="cpu"
    )


def test_parse_health_loading_has_null_dim() -> None:
    body = {"status": "loading", "model": "m", "dim": None, "device": "cpu"}
    health = image_embed.parse_health(body)
    assert health.status == "loading"
    assert health.dim is None


def test_parse_health_tolerates_malformed_fields() -> None:
    health = image_embed.parse_health({"status": 1, "model": 2, "dim": "not-an-int", "device": None})
    assert health == image_embed.ImageEmbedHealth(status="loading", model=None, dim=None, device=None)


def test_parse_health_rejects_bool_dim() -> None:
    # bool is a subclass of int in Python; dim must be a real integer.
    health = image_embed.parse_health({"status": "ok", "model": "m", "dim": True, "device": "cpu"})
    assert health.dim is None


def test_image_embed_health_reachable(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"status": "ok", "model": "m", "dim": 1024, "device": "cpu"}
    monkeypatch.setattr(
        image_embed._http,
        "get",
        lambda url, timeout=5: httpx.Response(200, json=body, request=httpx.Request("GET", url)),
    )
    health = image_embed.image_embed_health("http://image-embed:8012")
    assert health == image_embed.ImageEmbedHealth(status="ok", model="m", dim=1024, device="cpu")


def test_image_embed_health_none_on_bad_status(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(image_embed._http, "get", lambda url, timeout=5: httpx.Response(503))
    assert image_embed.image_embed_health("http://image-embed:8012") is None


def test_image_embed_health_none_on_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_connect_error(url: str, timeout: float = 5) -> httpx.Response:
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(image_embed._http, "get", raise_connect_error)
    assert image_embed.image_embed_health("http://image-embed:8012") is None


def test_dimension_guard_none_when_healthy() -> None:
    health = image_embed.ImageEmbedHealth(status="ok", model="m", dim=1024, device="cpu")
    assert image_embed.dimension_guard(health) is None


def test_dimension_guard_unreachable() -> None:
    assert image_embed.dimension_guard(None) == "image-embed sidecar unreachable"


def test_dimension_guard_loading() -> None:
    health = image_embed.ImageEmbedHealth(status="loading", model="m", dim=None, device="cpu")
    message = image_embed.dimension_guard(health)
    assert message is not None
    assert "status=loading" in message


def test_dimension_guard_dimension_mismatch_names_both_numbers() -> None:
    health = image_embed.ImageEmbedHealth(status="ok", model="m", dim=512, device="cpu")
    message = image_embed.dimension_guard(health)
    assert message == "image-embed sidecar dimension mismatch: expected 1024, got 512"


def test_parse_embed_response() -> None:
    body = {"model": "m", "dim": 3, "embeddings": [[0.1, 0.2, 0.3]]}
    embeddings, model = image_embed.parse_embed_response(body)
    assert embeddings == [[0.1, 0.2, 0.3]]
    assert model == "m"


@pytest.mark.parametrize(
    "body",
    [
        {"model": 1, "embeddings": [[0.1]]},
        {"model": "m", "embeddings": "not-a-list"},
        {"embeddings": [[0.1]]},
    ],
)
def test_parse_embed_response_rejects_malformed_body(body: dict[str, object]) -> None:
    with pytest.raises(ValueError, match="malformed"):
        image_embed.parse_embed_response(body)


def test_embed_images_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def fake_post(url: str, files: list[object], **kwargs: object) -> httpx.Response:
        calls.append(len(files))
        return httpx.Response(
            200,
            json={"model": "m", "dim": 2, "embeddings": [[0.1, 0.2] for _ in files]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(image_embed._http, "post", fake_post)
    embeddings, model = image_embed.embed_images([b"a", b"b", b"c"], "http://image-embed:8012", batch_size=2)
    assert len(embeddings) == 3
    assert model == "m"
    assert calls == [2, 1]


def test_embed_images_caps_batch_at_sidecar_max(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def fake_post(url: str, files: list[object], **kwargs: object) -> httpx.Response:
        calls.append(len(files))
        return httpx.Response(
            200,
            json={"model": "m", "dim": 1, "embeddings": [[0.0] for _ in files]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(image_embed._http, "post", fake_post)
    data = [b"x"] * (image_embed.MAX_IMAGES_PER_REQUEST + 5)
    embeddings, _model = image_embed.embed_images(data, "http://image-embed:8012", batch_size=999)
    assert len(embeddings) == len(data)
    assert calls == [image_embed.MAX_IMAGES_PER_REQUEST, 5]


def test_embed_images_empty_input_makes_no_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: object, **kw: object) -> httpx.Response:
        raise AssertionError("should not be called")

    monkeypatch.setattr(image_embed._http, "post", boom)
    embeddings, model = image_embed.embed_images([], "http://image-embed:8012", batch_size=8)
    assert embeddings == []
    assert model == ""


def test_embed_images_raises_on_server_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        image_embed._http, "post", lambda url, files, **kw: httpx.Response(500, request=httpx.Request("POST", url))
    )
    with pytest.raises(httpx.HTTPStatusError):
        image_embed.embed_images([b"a"], "http://image-embed:8012", batch_size=8)


@pytest.mark.parametrize(
    "ext,expected",
    [(".jpg", True), (".png", True), (".webp", True), (".pdf", False), (".mp4", False), (".txt", False)],
)
def test_is_image_candidate(ext: str, expected: bool) -> None:
    assert image_embed.is_image_candidate(ext) is expected


def test_is_image_embed_candidate_requires_image_kind_and_scope() -> None:
    assert image_embed.is_image_embed_candidate(".png", "alice/a.png", "alice") is True
    assert image_embed.is_image_embed_candidate(".png", "bob/a.png", "alice") is False
    assert image_embed.is_image_embed_candidate(".pdf", "alice/a.pdf", "alice") is False


def test_select_image_embed_candidates_filters_by_kind_and_scope() -> None:
    rows = [
        ("alice/a.png", ".png", "sha-a", 10),
        ("alice/a.pdf", ".pdf", "sha-b", 20),
        ("bob/b.png", ".png", "sha-c", 30),
    ]
    assert image_embed.select_image_embed_candidates(rows, "alice") == [("alice/a.png", ".png", "sha-a", 10)]


def test_needs_embedding_true_when_missing() -> None:
    assert image_embed.needs_embedding(None, "model-a") is True


def test_needs_embedding_false_when_current_model_matches() -> None:
    assert image_embed.needs_embedding("model-a", "model-a") is False


def test_needs_embedding_true_when_stale_model() -> None:
    assert image_embed.needs_embedding("model-old", "model-a") is True


def test_rebuild_needs_embedding_missing_always_true() -> None:
    assert image_embed.rebuild_needs_embedding(None, "model-a", force=False) is True
    assert image_embed.rebuild_needs_embedding(None, "model-a", force=True) is True


def test_rebuild_needs_embedding_matching_model_never_recomputed() -> None:
    assert image_embed.rebuild_needs_embedding("model-a", "model-a", force=False) is False
    assert image_embed.rebuild_needs_embedding("model-a", "model-a", force=True) is False


def test_rebuild_needs_embedding_stale_model_only_with_force() -> None:
    assert image_embed.rebuild_needs_embedding("model-old", "model-a", force=False) is False
    assert image_embed.rebuild_needs_embedding("model-old", "model-a", force=True) is True
