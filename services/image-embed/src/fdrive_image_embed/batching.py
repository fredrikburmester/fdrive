"""Pure batching: splits a sequence into fixed-size chunks, in order. Used both
by the real `Embedder` implementation (`siglip.py`, to bound how many images
or texts hit the model at once) and available to anything else that wants the
same behaviour.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence


def chunked[T](items: Sequence[T], size: int) -> Iterator[list[T]]:
    """`size <= 0` is treated as "no batching": one chunk with everything (or
    none at all for an empty input), rather than looping forever."""
    if size <= 0:
        if items:
            yield list(items)
        return
    for i in range(0, len(items), size):
        yield list(items[i : i + size])
