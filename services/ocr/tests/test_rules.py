from __future__ import annotations

from fdrive_ocr.rules import is_excluded, is_too_big, root_relative_key


def test_root_relative_key() -> None:
    assert root_relative_key("files", "docs/a.pdf") == "files/docs/a.pdf"


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
