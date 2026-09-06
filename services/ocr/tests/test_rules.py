from __future__ import annotations

from fdrive_ocr.rules import is_candidate_pdf, is_excluded, is_too_big, root_relative_key


def test_root_relative_key() -> None:
    assert root_relative_key("sftpgo", "docs/a.pdf") == "sftpgo/docs/a.pdf"


def test_is_excluded_matches_glob() -> None:
    # The glob is matched against the full `<root>/<rel>` key, so a bare
    # "Photos/**" (filesai's original, root-relative default) only excludes
    # paths under a root literally named "Photos"; excluding a subdirectory of
    # some other root needs a pattern that spells out the root, e.g.
    # "sftpgo/*/Photos/**". See docs/OCR.md.
    assert is_excluded("Photos", "2020/a.pdf", ["Photos/**"]) is True
    assert is_excluded("sftpgo", "alice/Photos/a.pdf", ["sftpgo/*/Photos/**"]) is True


def test_is_excluded_no_match() -> None:
    assert is_excluded("sftpgo", "docs/a.pdf", ["Photos/**"]) is False
    assert is_excluded("sftpgo", "Photos/2020/a.pdf", ["Photos/**"]) is False


def test_is_excluded_empty_globs() -> None:
    assert is_excluded("sftpgo", "docs/a.pdf", []) is False


def test_is_too_big_over_cap() -> None:
    assert is_too_big(300 * 1024 * 1024, 200) is True


def test_is_too_big_under_cap() -> None:
    assert is_too_big(100 * 1024 * 1024, 200) is False


def test_is_too_big_exactly_at_cap_is_not_too_big() -> None:
    assert is_too_big(200 * 1024 * 1024, 200) is False


def test_is_candidate_pdf_true() -> None:
    assert is_candidate_pdf("report.pdf") is True
    assert is_candidate_pdf("REPORT.PDF") is True


def test_is_candidate_pdf_rejects_apple_double() -> None:
    assert is_candidate_pdf("._report.pdf") is False


def test_is_candidate_pdf_rejects_non_pdf() -> None:
    assert is_candidate_pdf("report.txt") is False
