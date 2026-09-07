"""The `Embedder` protocol every model backend implements, and the exception an
implementation raises for bytes it cannot decode as an image. Deliberately
free of any torch/transformers/pillow import, so importing this module (or
anything that only needs the protocol, like `server.py` and the tests' fake)
never pulls in the runtime-only dependencies.
"""

from __future__ import annotations

from typing import Protocol


class ImageDecodeError(ValueError):
    """Raised by an `Embedder.embed_images` implementation when a part's bytes
    cannot be decoded as an image. `server.py` maps this to a 400 response."""


class Embedder(Protocol):
    model_id: str
    dim: int

    def embed_images(self, images: list[bytes]) -> list[list[float]]: ...  # pragma: no cover

    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...  # pragma: no cover
