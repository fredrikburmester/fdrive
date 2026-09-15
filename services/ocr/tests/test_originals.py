from __future__ import annotations

import pytest

from fdrive_ocr.originals import (
    REFUSAL_TARGET_CHANGED,
    REFUSAL_TARGET_MISSING,
    STATE_CHANGED,
    STATE_MISSING,
    STATE_OCRED,
    STATE_RESTORED,
    Mapping,
    TargetStat,
    classify_state,
    is_valid_id,
    mapping_document,
    matches_query,
    parse_mapping,
    restore_refusal,
    retention_cutoff,
)

MAPPING = Mapping(
    root="sftpgo",
    path="fredrik/docs/scan.pdf",
    size=1024,
    mtime_ns=1_700_000_000_123_456_789,
    original="0123456789abcdef_scan.pdf",
    sha256="a" * 64,
    legacy=False,
    kept_at_ns=1_800_000_000_000_000_000,
)


# -- is_valid_id ------------------------------------------------------------------


@pytest.mark.parametrize("value", ["0123456789abcdef_scan.pdf", "a", "name with spaces.pdf", "räksmörgås.pdf"])
def test_accepts_a_plain_filename(value: str) -> None:
    assert is_valid_id(value) is True


@pytest.mark.parametrize(
    "value",
    [
        "",
        "..",
        ".",
        "../../etc/passwd",
        "sub/scan.pdf",
        "sub\\scan.pdf",
        "scan\0.pdf",
        ".original-abc",  # a half-written keep, never addressable
        ".mapping-abc",
        "x" * 513,
    ],
)
def test_rejects_anything_that_is_not_a_plain_filename(value: str) -> None:
    assert is_valid_id(value) is False


# -- parse_mapping / mapping_document ----------------------------------------------


def test_round_trips_a_mapping_document() -> None:
    assert parse_mapping(mapping_document(MAPPING)) == MAPPING


def test_round_trips_a_legacy_mapping_without_a_kept_at() -> None:
    mapping = Mapping(**{**MAPPING.__dict__, "legacy": True, "kept_at_ns": None})
    document = mapping_document(mapping)
    assert document["legacy"] is True
    assert "kept_at_ns" not in document
    assert parse_mapping(document) == mapping


def test_reads_mtime_ns_written_as_a_string() -> None:
    parsed = parse_mapping({**mapping_document(MAPPING), "mtime_ns": "42"})
    assert parsed is not None
    assert parsed.mtime_ns == 42


def test_tolerates_unknown_fields_a_newer_service_added() -> None:
    assert parse_mapping({**mapping_document(MAPPING), "somethingNew": 1}) == MAPPING


@pytest.mark.parametrize(
    "override",
    [
        {"version": 2},
        {"version": None},
        {"root": ""},
        {"root": 3},
        {"path": ""},
        {"path": None},
        {"original": "../escape.pdf"},
        {"original": 7},
        {"size": "big"},
        {"size": True},
        {"mtime_ns": "not-a-number"},
        {"mtime_ns": None},
    ],
)
def test_rejects_a_malformed_document(override: dict[str, object]) -> None:
    assert parse_mapping({**mapping_document(MAPPING), **override}) is None


@pytest.mark.parametrize("raw", [None, "a string", 5, ["list"]])
def test_rejects_a_document_that_is_not_an_object(raw: object) -> None:
    assert parse_mapping(raw) is None


def test_treats_a_missing_checksum_as_unknown_rather_than_invalid() -> None:
    parsed = parse_mapping({**mapping_document(MAPPING), "sha256": None})
    assert parsed is not None
    assert parsed.sha256 is None


# -- classify_state ----------------------------------------------------------------

OCRED_KEYS = frozenset({(2048, MAPPING.mtime_ns)})


def test_absent_file_is_missing() -> None:
    assert classify_state(None, MAPPING.size, MAPPING.mtime_ns, OCRED_KEYS) == STATE_MISSING


def test_file_matching_the_kept_original_is_already_restored() -> None:
    target = TargetStat(size=MAPPING.size, mtime_ns=MAPPING.mtime_ns)
    assert classify_state(target, MAPPING.size, MAPPING.mtime_ns, OCRED_KEYS) == STATE_RESTORED


def test_file_matching_a_recorded_ocr_result_is_the_ocr_output() -> None:
    target = TargetStat(size=2048, mtime_ns=MAPPING.mtime_ns)
    assert classify_state(target, MAPPING.size, MAPPING.mtime_ns, OCRED_KEYS) == STATE_OCRED


def test_file_matching_neither_has_changed_since_ocr() -> None:
    target = TargetStat(size=4096, mtime_ns=MAPPING.mtime_ns + 5)
    assert classify_state(target, MAPPING.size, MAPPING.mtime_ns, OCRED_KEYS) == STATE_CHANGED


def test_a_file_with_no_recorded_ocr_result_has_changed() -> None:
    target = TargetStat(size=2048, mtime_ns=MAPPING.mtime_ns)
    assert classify_state(target, MAPPING.size, MAPPING.mtime_ns, frozenset()) == STATE_CHANGED


# -- restore_refusal ---------------------------------------------------------------


def test_restoring_over_the_ocr_output_needs_no_opt_in() -> None:
    assert restore_refusal(STATE_OCRED, False, False) is None


def test_restoring_over_an_already_restored_file_needs_no_opt_in() -> None:
    assert restore_refusal(STATE_RESTORED, False, False) is None


def test_recreating_a_deleted_file_requires_the_caller_to_ask() -> None:
    assert restore_refusal(STATE_MISSING, False, False) == REFUSAL_TARGET_MISSING
    assert restore_refusal(STATE_MISSING, True, False) is None


def test_overwriting_a_changed_file_requires_the_caller_to_ask() -> None:
    assert restore_refusal(STATE_CHANGED, False, False) == REFUSAL_TARGET_CHANGED
    assert restore_refusal(STATE_CHANGED, False, True) is None


def test_one_opt_in_does_not_grant_the_other() -> None:
    assert restore_refusal(STATE_CHANGED, True, False) == REFUSAL_TARGET_CHANGED
    assert restore_refusal(STATE_MISSING, False, True) == REFUSAL_TARGET_MISSING


# -- retention_cutoff ---------------------------------------------------------------


@pytest.mark.parametrize("days", [0, -1, -365])
def test_retention_off_keeps_everything(days: int) -> None:
    assert retention_cutoff(1_000_000.0, days) is None


def test_retention_cutoff_is_the_window_before_now() -> None:
    assert retention_cutoff(1_000_000.0, 2) == 1_000_000.0 - 172800.0


# -- matches_query -------------------------------------------------------------------


def test_an_empty_query_matches_everything() -> None:
    assert matches_query(MAPPING, MAPPING.original, "   ") is True
    assert matches_query(None, "anything", "") is True


def test_query_matches_the_source_path_case_insensitively() -> None:
    assert matches_query(MAPPING, MAPPING.original, "DOCS/scan") is True
    assert matches_query(MAPPING, MAPPING.original, "sftpgo/fredrik") is True
    assert matches_query(MAPPING, MAPPING.original, "invoices") is False


def test_an_unresolved_original_is_searchable_by_its_identifier() -> None:
    assert matches_query(None, "0123456789abcdef_scan.pdf", "scan") is True
    assert matches_query(None, "0123456789abcdef_scan.pdf", "invoice") is False
