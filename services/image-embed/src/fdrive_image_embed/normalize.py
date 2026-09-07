"""Pure L2 normalization. Every vector this service returns has unit length,
so a caller's cosine distance in pgvector reduces to a plain dot product and
no caller ever has to remember to normalize itself (orchestrator decision 4 in
`docs/workflow/P7-IMAGE-SEARCH-BUILD.md`).
"""

from __future__ import annotations

import math


def l2_normalize(vectors: list[list[float]]) -> list[list[float]]:
    return [_normalize_one(v) for v in vectors]


def _normalize_one(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector))
    if norm == 0.0:
        # A real embedding is never the zero vector, but guard against
        # dividing by zero anyway rather than returning NaNs.
        return list(vector)
    return [x / norm for x in vector]
