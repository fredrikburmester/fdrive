"""Pulls the pooled embedding out of whatever `get_image_features` and
`get_text_features` return.

Kept separate from `siglip.py`, and free of any torch import, so the one
piece of the model backend that actually varies between transformers
versions is unit-testable without loading a model: transformers 5.x returns
a `BaseModelOutputWithPooling` whose `pooler_output` is the `(batch, dim)`
tensor, while earlier versions returned that tensor directly. Serving the
output object to `.tolist()` is what a real model load caught and no fake
could.
"""

from __future__ import annotations

from typing import Any


class UnexpectedFeaturesError(RuntimeError):
    """The model returned something with neither `.tolist()` nor a usable
    `pooler_output`. A transformers upgrade changing this shape again should
    fail loudly here, not silently embed nonsense."""


def pooled_features(result: Any) -> Any:
    """The `(batch, dim)` tensor from `result`: `result` itself when it is
    already tensor-like, else its `pooler_output`."""
    if hasattr(result, "tolist"):
        return result
    pooled = getattr(result, "pooler_output", None)
    if pooled is not None and hasattr(pooled, "tolist"):
        return pooled
    raise UnexpectedFeaturesError(f"model returned {type(result).__name__} with no usable pooled output")
