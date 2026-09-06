from __future__ import annotations

from fdrive_ocr.settings import (
    EXCLUDE_GLOBS_KEY,
    HOUR_KEY,
    KEEP_ORIGINALS_KEY,
    LANGS_KEY,
    MAX_MB_KEY,
    Settings,
    default_settings,
    diff_changed,
    resolve_settings,
)

DEFAULTS = default_settings()


def test_default_settings_values() -> None:
    d = default_settings()
    assert d.hour == 3
    assert d.langs == "swe+eng"
    assert d.exclude_globs == ("Programs/**", "Photos/**", "Videos/**")
    assert d.max_mb == 200
    assert d.keep_originals is True


def test_resolve_settings_empty_raw_uses_defaults() -> None:
    resolved = resolve_settings({}, DEFAULTS)
    assert resolved == DEFAULTS


def test_resolve_settings_overrides_every_field() -> None:
    raw = {
        HOUR_KEY: 4,
        LANGS_KEY: "eng",
        EXCLUDE_GLOBS_KEY: ["A/**", "B/**"],
        MAX_MB_KEY: 50,
        KEEP_ORIGINALS_KEY: False,
    }
    resolved = resolve_settings(raw, DEFAULTS)
    assert resolved == Settings(hour=4, langs="eng", exclude_globs=("A/**", "B/**"), max_mb=50, keep_originals=False)


def test_resolve_settings_decodes_json_strings_from_a_text_only_driver() -> None:
    raw = {
        HOUR_KEY: "5",
        LANGS_KEY: '"eng"',
        EXCLUDE_GLOBS_KEY: '["X/**"]',
        MAX_MB_KEY: "75",
        KEEP_ORIGINALS_KEY: "false",
    }
    resolved = resolve_settings(raw, DEFAULTS)
    assert resolved.hour == 5
    assert resolved.langs == "eng"
    assert resolved.exclude_globs == ("X/**",)
    assert resolved.max_mb == 75
    assert resolved.keep_originals is False


def test_resolve_settings_hour_out_of_range_falls_back() -> None:
    assert resolve_settings({HOUR_KEY: 24}, DEFAULTS).hour == DEFAULTS.hour
    assert resolve_settings({HOUR_KEY: -1}, DEFAULTS).hour == DEFAULTS.hour
    assert resolve_settings({HOUR_KEY: 0}, DEFAULTS).hour == 0
    assert resolve_settings({HOUR_KEY: 23}, DEFAULTS).hour == 23


def test_resolve_settings_int_rejects_bool_and_non_numeric_string() -> None:
    assert resolve_settings({MAX_MB_KEY: True}, DEFAULTS).max_mb == DEFAULTS.max_mb
    assert resolve_settings({MAX_MB_KEY: "not-a-number"}, DEFAULTS).max_mb == DEFAULTS.max_mb
    assert resolve_settings({MAX_MB_KEY: "-5"}, DEFAULTS).max_mb == -5


def test_resolve_settings_int_from_a_string_that_is_not_valid_json() -> None:
    # "007" has a leading zero, which is not valid JSON, so `_decode` falls
    # back to the raw string and the digit-string branch of `_parse_int` runs.
    assert resolve_settings({MAX_MB_KEY: "007"}, DEFAULTS).max_mb == 7


def test_resolve_settings_glob_list_rejects_non_list_and_mixed_types() -> None:
    assert resolve_settings({EXCLUDE_GLOBS_KEY: "not-a-list"}, DEFAULTS).exclude_globs == DEFAULTS.exclude_globs
    assert resolve_settings({EXCLUDE_GLOBS_KEY: ["ok", 1]}, DEFAULTS).exclude_globs == DEFAULTS.exclude_globs


def test_resolve_settings_str_rejects_blank_and_non_string() -> None:
    assert resolve_settings({LANGS_KEY: "   "}, DEFAULTS).langs == DEFAULTS.langs
    assert resolve_settings({LANGS_KEY: 5}, DEFAULTS).langs == DEFAULTS.langs


def test_resolve_settings_bool_accepts_various_string_forms() -> None:
    for truthy in ("true", "1", "yes", "on", "TRUE"):
        assert resolve_settings({KEEP_ORIGINALS_KEY: truthy}, DEFAULTS).keep_originals is True
    for falsy in ("false", "0", "no", "off", "FALSE"):
        assert resolve_settings({KEEP_ORIGINALS_KEY: falsy}, DEFAULTS).keep_originals is False


def test_resolve_settings_bool_rejects_unrecognised_string_and_non_bool() -> None:
    assert resolve_settings({KEEP_ORIGINALS_KEY: "maybe"}, DEFAULTS).keep_originals == DEFAULTS.keep_originals
    assert resolve_settings({KEEP_ORIGINALS_KEY: 5}, DEFAULTS).keep_originals == DEFAULTS.keep_originals


def test_decode_invalid_json_string_passes_through() -> None:
    # A malformed JSON string for an int field falls back to the default via
    # the non-digit check, exercising `_decode`'s `json.loads` failure path.
    resolved = resolve_settings({MAX_MB_KEY: "{not json"}, DEFAULTS)
    assert resolved.max_mb == DEFAULTS.max_mb


def test_diff_changed_detects_each_field() -> None:
    changed = Settings(hour=4, langs="eng", exclude_globs=("A/**",), max_mb=10, keep_originals=False)
    names = diff_changed(DEFAULTS, changed)
    assert set(names) == {"hour", "langs", "exclude_globs", "max_mb", "keep_originals"}


def test_diff_changed_empty_when_equal() -> None:
    assert diff_changed(DEFAULTS, DEFAULTS) == []
