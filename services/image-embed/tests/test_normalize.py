from __future__ import annotations

import math

from fdrive_image_embed.normalize import l2_normalize


def test_normalizes_to_unit_length() -> None:
    [v] = l2_normalize([[3.0, 4.0]])
    assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0)
    assert v == [0.6, 0.8]


def test_normalizes_multiple_vectors_independently_and_preserves_order() -> None:
    out = l2_normalize([[1.0, 0.0], [0.0, 2.0]])
    assert out == [[1.0, 0.0], [0.0, 1.0]]


def test_zero_vector_is_returned_unchanged() -> None:
    assert l2_normalize([[0.0, 0.0, 0.0]]) == [[0.0, 0.0, 0.0]]


def test_empty_list_returns_empty_list() -> None:
    assert l2_normalize([]) == []
