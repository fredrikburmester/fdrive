"""Shared test fixtures: a fake `Embedder` that never touches torch, so the
whole HTTP surface (and `main.py`'s wiring) is testable without the
`runtime` extra installed, per the "Testability" requirement in
`services/image-embed/README.md`.
"""

from __future__ import annotations

from fdrive_image_embed.embedder import ImageDecodeError

UNDECODABLE = b"not-an-image"


class FakeEmbedder:
    """A deterministic stand-in for `SiglipEmbedder`: turns each image/text
    into a fixed-size vector derived from its length, so tests can assert on
    shape and ordering without a real model. Raises `ImageDecodeError` for
    the `UNDECODABLE` sentinel bytes, mimicking a real decode failure."""

    def __init__(self, model_id: str = "fake/model", dim: int = 4) -> None:
        self.model_id = model_id
        self.dim = dim

    def embed_images(self, images: list[bytes]) -> list[list[float]]:
        out: list[list[float]] = []
        for image in images:
            if image == UNDECODABLE:
                raise ImageDecodeError("not an image")
            out.append(self._vector(len(image)))
        return out

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(len(t)) for t in texts]

    def _vector(self, seed: int) -> list[float]:
        # "+ 1" keeps every component nonzero, so the result is never the
        # zero vector `l2_normalize` special-cases.
        return [float((seed + i) % 7 + 1) for i in range(self.dim)]
