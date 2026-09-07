"""`pooled_features` is the one part of the model backend that varies between
transformers versions, so it is the one part that is unit-tested without a
model: transformers 5.x returns an output object, older versions returned the
tensor itself.
"""

from __future__ import annotations

import pytest

from fdrive_image_embed.features import UnexpectedFeaturesError, pooled_features


class FakeTensor:
    def tolist(self) -> list[list[float]]:
        return [[1.0, 2.0]]


class FakeOutput:
    """Shaped like transformers' `BaseModelOutputWithPooling`."""

    def __init__(self) -> None:
        self.pooler_output = FakeTensor()
        self.last_hidden_state = object()


class FakeOutputWithoutPooling:
    def __init__(self) -> None:
        self.pooler_output = None


def test_returns_a_tensor_unchanged() -> None:
    tensor = FakeTensor()
    assert pooled_features(tensor) is tensor


def test_unwraps_an_output_objects_pooler_output() -> None:
    output = FakeOutput()
    assert pooled_features(output) is output.pooler_output


def test_raises_when_there_is_no_usable_pooled_output() -> None:
    with pytest.raises(UnexpectedFeaturesError, match="FakeOutputWithoutPooling"):
        pooled_features(FakeOutputWithoutPooling())


def test_raises_for_an_unrelated_object() -> None:
    with pytest.raises(UnexpectedFeaturesError):
        pooled_features(object())
