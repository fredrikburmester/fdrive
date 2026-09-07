from __future__ import annotations

from fdrive_image_embed.batching import chunked


def test_chunked_splits_evenly() -> None:
    assert list(chunked([1, 2, 3, 4], 2)) == [[1, 2], [3, 4]]


def test_chunked_last_batch_is_partial() -> None:
    assert list(chunked([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]


def test_chunked_size_larger_than_input() -> None:
    assert list(chunked([1, 2], 10)) == [[1, 2]]


def test_chunked_empty_input() -> None:
    assert list(chunked([], 4)) == []


def test_chunked_non_positive_size_yields_one_chunk() -> None:
    assert list(chunked([1, 2, 3], 0)) == [[1, 2, 3]]
    assert list(chunked([1, 2, 3], -1)) == [[1, 2, 3]]


def test_chunked_non_positive_size_with_empty_input_yields_nothing() -> None:
    assert list(chunked([], 0)) == []
