import json

from fdrive_indexer.settings import (
    OCR_IMAGE_GLOBS_KEY,
    SCAN_INTERVAL_KEY,
    TESSERACT_LANGS_KEY,
    TEXT_EXCLUDE_GLOBS_KEY,
    WORKERS_KEY,
    Settings,
    diff_changed,
    resolve_settings,
)

DEFAULTS = Settings(
    scan_interval_seconds=900,
    workers=4,
    text_exclude_globs=("sftpgo/Photos/*",),
    ocr_image_globs=("sftpgo/Documents/*",),
    tesseract_langs="swe+eng",
)


def test_resolve_settings_all_defaults_when_empty() -> None:
    assert resolve_settings({}, DEFAULTS) == DEFAULTS


def test_resolve_settings_overrides_int_values() -> None:
    raw = {SCAN_INTERVAL_KEY: 60, WORKERS_KEY: 8}
    result = resolve_settings(raw, DEFAULTS)
    assert result.scan_interval_seconds == 60
    assert result.workers == 8


def test_resolve_settings_int_as_json_string() -> None:
    raw = {SCAN_INTERVAL_KEY: json.dumps(120)}
    result = resolve_settings(raw, DEFAULTS)
    assert result.scan_interval_seconds == 120


def test_resolve_settings_int_non_json_digit_string() -> None:
    # "007" is not valid JSON (leading zero), so _decode leaves it as a string and
    # the digit fallback in _parse_int has to handle it.
    raw = {SCAN_INTERVAL_KEY: "007"}
    assert resolve_settings(raw, DEFAULTS).scan_interval_seconds == 7


def test_resolve_settings_int_invalid_falls_back() -> None:
    raw = {WORKERS_KEY: "not-a-number"}
    assert resolve_settings(raw, DEFAULTS).workers == DEFAULTS.workers


def test_resolve_settings_bool_is_not_treated_as_int() -> None:
    raw = {WORKERS_KEY: True}
    assert resolve_settings(raw, DEFAULTS).workers == DEFAULTS.workers


def test_resolve_settings_glob_list_override() -> None:
    raw = {TEXT_EXCLUDE_GLOBS_KEY: ["sftpgo/Videos/*", "sftpgo/Raw/*"]}
    result = resolve_settings(raw, DEFAULTS)
    assert result.text_exclude_globs == ("sftpgo/Videos/*", "sftpgo/Raw/*")


def test_resolve_settings_glob_list_as_json_string() -> None:
    raw = {OCR_IMAGE_GLOBS_KEY: json.dumps(["sftpgo/Scans/*"])}
    result = resolve_settings(raw, DEFAULTS)
    assert result.ocr_image_globs == ("sftpgo/Scans/*",)


def test_resolve_settings_glob_list_invalid_falls_back() -> None:
    raw = {TEXT_EXCLUDE_GLOBS_KEY: "not-a-list"}
    assert resolve_settings(raw, DEFAULTS).text_exclude_globs == DEFAULTS.text_exclude_globs


def test_resolve_settings_glob_list_mixed_types_falls_back() -> None:
    raw = {TEXT_EXCLUDE_GLOBS_KEY: ["ok", 1]}
    assert resolve_settings(raw, DEFAULTS).text_exclude_globs == DEFAULTS.text_exclude_globs


def test_resolve_settings_string_override() -> None:
    raw = {TESSERACT_LANGS_KEY: "eng"}
    assert resolve_settings(raw, DEFAULTS).tesseract_langs == "eng"


def test_resolve_settings_string_blank_falls_back() -> None:
    raw = {TESSERACT_LANGS_KEY: "   "}
    assert resolve_settings(raw, DEFAULTS).tesseract_langs == DEFAULTS.tesseract_langs


def test_resolve_settings_string_wrong_type_falls_back() -> None:
    raw = {TESSERACT_LANGS_KEY: 42}
    assert resolve_settings(raw, DEFAULTS).tesseract_langs == DEFAULTS.tesseract_langs


def test_resolve_settings_invalid_json_string_kept_as_is_then_rejected() -> None:
    raw = {TEXT_EXCLUDE_GLOBS_KEY: "[unterminated"}
    assert resolve_settings(raw, DEFAULTS).text_exclude_globs == DEFAULTS.text_exclude_globs


def test_diff_changed_none() -> None:
    assert diff_changed(DEFAULTS, DEFAULTS) == []


def test_diff_changed_some_fields() -> None:
    new = resolve_settings({WORKERS_KEY: 9, TESSERACT_LANGS_KEY: "eng"}, DEFAULTS)
    changed = diff_changed(DEFAULTS, new)
    assert set(changed) == {"workers", "tesseract_langs"}
