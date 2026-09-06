from __future__ import annotations

from fdrive_ocr.decide import (
    STATUS_ENCRYPTED,
    STATUS_FAILED,
    STATUS_HAS_TEXT,
    STATUS_OCRED,
    STATUS_SIGNED,
    STATUS_TIMEOUT,
    decide,
)


def test_decide_timeout_wins_over_everything() -> None:
    d = decide(0, "", timed_out=True)
    assert d.status == STATUS_TIMEOUT
    assert d.rewrite is False
    assert d.detail == "ocrmypdf timed out"


def test_decide_success() -> None:
    d = decide(0, "")
    assert d.status == STATUS_OCRED
    assert d.rewrite is True
    assert d.detail is None


def test_decide_exit_6_has_text() -> None:
    d = decide(6, "")
    assert d.status == STATUS_HAS_TEXT
    assert d.rewrite is False


def test_decide_tagged_pdf_error_maps_to_has_text() -> None:
    d = decide(1, "ocrmypdf.exceptions.TaggedPDFError: nope")
    assert d.status == STATUS_HAS_TEXT
    assert d.rewrite is False


def test_decide_digital_signature_error() -> None:
    d = decide(1, "ocrmypdf.exceptions.DigitalSignatureError: nope")
    assert d.status == STATUS_SIGNED
    assert d.rewrite is False


def test_decide_encrypted_pdf_error() -> None:
    d = decide(1, "ocrmypdf.exceptions.EncryptedPdfError: nope")
    assert d.status == STATUS_ENCRYPTED
    assert d.rewrite is False


def test_decide_unknown_failure_keeps_tail_of_stderr() -> None:
    stderr = "line1\nline2\nline3\nline4\nline5"
    d = decide(1, stderr)
    assert d.status == STATUS_FAILED
    assert d.rewrite is False
    assert d.detail == "line3\nline4\nline5"


def test_decide_unknown_failure_with_empty_stderr_uses_exit_code() -> None:
    d = decide(2, "   ")
    assert d.status == STATUS_FAILED
    assert d.detail == "exit code 2"
