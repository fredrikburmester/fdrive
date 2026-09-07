from __future__ import annotations

import pytest

from fdrive_image_embed.validation import (
    MAX_IMAGE_BYTES,
    MAX_IMAGES,
    MAX_TEXT_CHARS,
    MAX_TEXTS,
    RequestError,
    parse_text_inputs,
    validate_images,
    validate_texts,
)

# -- validate_images --------------------------------------------------------------


def test_validate_images_accepts_a_normal_request() -> None:
    validate_images([b"a", b"b"])


def test_validate_images_rejects_empty_list() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_images([])
    assert exc_info.value.status_code == 400


def test_validate_images_rejects_too_many() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_images([b"x"] * (MAX_IMAGES + 1))
    assert exc_info.value.status_code == 413


def test_validate_images_accepts_exactly_the_max() -> None:
    validate_images([b"x"] * MAX_IMAGES)


def test_validate_images_rejects_an_oversized_part() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_images([b"x" * (MAX_IMAGE_BYTES + 1)])
    assert exc_info.value.status_code == 413


def test_validate_images_accepts_exactly_the_max_size() -> None:
    validate_images([b"x" * MAX_IMAGE_BYTES])


# -- validate_texts -----------------------------------------------------------------


def test_validate_texts_accepts_a_normal_request() -> None:
    validate_texts(["blue chair"])


def test_validate_texts_rejects_empty_list() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_texts([])
    assert exc_info.value.status_code == 400


def test_validate_texts_rejects_too_many() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_texts(["x"] * (MAX_TEXTS + 1))
    assert exc_info.value.status_code == 413


def test_validate_texts_accepts_exactly_the_max() -> None:
    validate_texts(["x"] * MAX_TEXTS)


def test_validate_texts_rejects_an_oversized_text() -> None:
    with pytest.raises(RequestError) as exc_info:
        validate_texts(["x" * (MAX_TEXT_CHARS + 1)])
    assert exc_info.value.status_code == 413


def test_validate_texts_accepts_exactly_the_max_length() -> None:
    validate_texts(["x" * MAX_TEXT_CHARS])


# -- parse_text_inputs --------------------------------------------------------------


def test_parse_text_inputs_extracts_the_list() -> None:
    assert parse_text_inputs({"inputs": ["a", "b"]}) == ["a", "b"]


def test_parse_text_inputs_rejects_non_object_body() -> None:
    with pytest.raises(RequestError) as exc_info:
        parse_text_inputs(["a", "b"])
    assert exc_info.value.status_code == 400


def test_parse_text_inputs_rejects_missing_inputs_key() -> None:
    with pytest.raises(RequestError) as exc_info:
        parse_text_inputs({})
    assert exc_info.value.status_code == 400


def test_parse_text_inputs_rejects_non_list_inputs() -> None:
    with pytest.raises(RequestError):
        parse_text_inputs({"inputs": "blue chair"})


def test_parse_text_inputs_rejects_non_string_items() -> None:
    with pytest.raises(RequestError):
        parse_text_inputs({"inputs": ["a", 1]})
