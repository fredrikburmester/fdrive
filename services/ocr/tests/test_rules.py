from __future__ import annotations

import pytest

from fdrive_ocr.rules import has_encrypted_part, is_encrypted_name, is_excluded, is_too_big, root_relative_key


def _sealed(chars: int, alphabet: str = "a2") -> str:
    """A name with the encrypted prefix and `chars` base32 characters after it."""
    return "fe1-" + (alphabet * chars)[:chars]


def test_root_relative_key() -> None:
    assert root_relative_key("files", "docs/a.pdf") == "files/docs/a.pdf"


@pytest.mark.parametrize("chars", [47, 48, 50, 52, 53, 55, 56, 248, 250])
def test_encrypted_names_of_every_valid_length(chars: int) -> None:
    assert is_encrypted_name(_sealed(chars)) is True


@pytest.mark.parametrize("chars", [0, 46, 49, 51, 54, 57, 251])
def test_lengths_base32_never_gives_are_not_encrypted_names(chars: int) -> None:
    assert is_encrypted_name(_sealed(chars)) is False


@pytest.mark.parametrize(
    "name",
    [
        _sealed(48).upper(),
        _sealed(48).replace("fe1-", "fe2-"),
        _sealed(48, "a1"),
        _sealed(48) + ".pdf",
        "x" + _sealed(48),
        "scan.pdf",
        "",
    ],
)
def test_clear_names_are_not_encrypted_names(name: str) -> None:
    assert is_encrypted_name(name) is False


def test_any_encrypted_part_puts_a_path_inside_an_encrypted_folder() -> None:
    assert has_encrypted_part(f"alice/.trash/0b8f/{_sealed(48)}") is True
    assert has_encrypted_part(f"alice/Secret/{_sealed(48)}/scan.pdf") is True
    assert has_encrypted_part("alice/Secret/scan.pdf") is False


def test_is_excluded_matches_glob() -> None:
    # The glob is matched against the full `<root>/<rel>` key, so a bare
    # "Photos/**" (filesai's original, root-relative default) only excludes
    # paths under a root literally named "Photos"; excluding a subdirectory of
    # some other root needs a pattern that spells out the root, e.g.
    # "files/*/Photos/**". See docs/OCR.md.
    assert is_excluded("Photos", "2020/a.pdf", ["Photos/**"]) is True
    assert is_excluded("files", "alice/Photos/a.pdf", ["files/*/Photos/**"]) is True


def test_is_excluded_no_match() -> None:
    assert is_excluded("files", "docs/a.pdf", ["Photos/**"]) is False
    assert is_excluded("files", "Photos/2020/a.pdf", ["Photos/**"]) is False


def test_is_excluded_empty_globs() -> None:
    assert is_excluded("files", "docs/a.pdf", []) is False


def test_is_excluded_none_include_globs_behaves_like_no_restriction() -> None:
    assert is_excluded("files", "docs/a.pdf", [], None) is False


def test_include_globs_restricts_to_matching_paths() -> None:
    assert is_excluded("files", "fredrik/report.pdf", [], ["files/fredrik/**"]) is False
    assert is_excluded("files", "alice/report.pdf", [], ["files/fredrik/**"]) is True


def test_include_globs_still_applies_exclude_globs_on_top() -> None:
    # Included by OCR_INCLUDE_GLOBS, but still excluded by an explicit exclude glob.
    assert (
        is_excluded("files", "fredrik/Photos/a.pdf", ["files/*/Photos/**"], ["files/fredrik/**"])
        is True
    )
    assert (
        is_excluded("files", "fredrik/docs/a.pdf", ["files/*/Photos/**"], ["files/fredrik/**"])
        is False
    )


def test_empty_include_globs_list_behaves_like_no_restriction() -> None:
    assert is_excluded("files", "docs/a.pdf", [], []) is False


def test_is_too_big_over_cap() -> None:
    assert is_too_big(300 * 1024 * 1024, 200) is True


def test_is_too_big_under_cap() -> None:
    assert is_too_big(100 * 1024 * 1024, 200) is False


def test_is_too_big_exactly_at_cap_is_not_too_big() -> None:
    assert is_too_big(200 * 1024 * 1024, 200) is False
