"""The real `Embedder` backend: SigLIP 2 through transformers, on CPU or CUDA.
Every import that pulls in torch, transformers, or pillow is deferred to
inside these functions, so importing this module never requires the
`runtime` extra to be installed; only `main.py`'s production entrypoint
(which needs those packages installed anyway to serve real embeddings) ever
calls into it.

Excluded from coverage: exercising this for real means loading actual model
weights, which the test suite deliberately never does (see the
test setup in `services/image-embed/README.md`). The
`Embedder` protocol plus `tests/conftest.py`'s `FakeEmbedder` cover
everything downstream of it (`server.py`, request validation, batching,
normalization) without touching torch at all.
"""

from __future__ import annotations

from typing import Any

from .batching import chunked
from .embedder import Embedder, ImageDecodeError
from .features import pooled_features


def load_embedder(model_id: str, device: str, threads: int | None, batch_size: int) -> Embedder:  # pragma: no cover
    """Loads the model and its processor from the Hugging Face hub (or the
    local `HF_HOME` cache) and returns a ready `SiglipEmbedder`. Blocking:
    `main.py` calls this from a background thread so `/health` answers
    immediately with `"loading"` while it runs."""
    import torch
    from transformers import AutoModel, AutoProcessor

    if threads is not None:
        torch.set_num_threads(threads)
    model = AutoModel.from_pretrained(model_id)
    model.to(device)
    model.eval()
    processor = AutoProcessor.from_pretrained(model_id)
    dim = int(model.config.vision_config.hidden_size)
    return SiglipEmbedder(model, processor, device, model_id, dim, batch_size)


class SiglipEmbedder:  # pragma: no cover
    """Wraps a loaded SigLIP 2 model and processor behind the `Embedder`
    protocol. All inference runs under `torch.inference_mode()`, batched at
    `batch_size` (`IMAGE_EMBED_BATCH_SIZE`)."""

    def __init__(self, model: Any, processor: Any, device: str, model_id: str, dim: int, batch_size: int) -> None:
        self._model = model
        self._processor = processor
        self._device = device
        self.model_id = model_id
        self.dim = dim
        self._batch_size = batch_size

    def embed_images(self, images: list[bytes]) -> list[list[float]]:
        import io

        import torch
        from PIL import Image

        out: list[list[float]] = []
        for batch in chunked(images, self._batch_size):
            pictures = []
            for raw in batch:
                try:
                    pictures.append(Image.open(io.BytesIO(raw)).convert("RGB"))
                except Exception as e:
                    raise ImageDecodeError(str(e)) from e
            inputs = self._processor(images=pictures, return_tensors="pt").to(self._device)
            with torch.inference_mode():
                features = pooled_features(self._model.get_image_features(**inputs))
            out.extend(features.to("cpu").tolist())
        return out

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        import torch

        out: list[list[float]] = []
        for batch in chunked(texts, self._batch_size):
            inputs = self._processor(text=batch, return_tensors="pt", padding="max_length", truncation=True).to(self._device)
            with torch.inference_mode():
                features = pooled_features(self._model.get_text_features(**inputs))
            out.extend(features.to("cpu").tolist())
        return out
