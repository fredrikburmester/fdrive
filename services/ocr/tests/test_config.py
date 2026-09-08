from __future__ import annotations

import pytest

from fdrive_ocr.config import DEFAULT_EXCLUDE_GLOBS, Config, parse_glob_list, parse_roots


def test_parse_roots_multiple() -> None:
    assert parse_roots("sftpgo=/roots/sftpgo,photos=/roots/photos") == {
        "sftpgo": "/roots/sftpgo",
        "photos": "/roots/photos",
    }


def test_parse_roots_empty_string() -> None:
    assert parse_roots("") == {}


def test_parse_roots_skips_malformed_pairs() -> None:
    assert parse_roots("sftpgo=/roots/sftpgo,,broken,=novalue,noeq=") == {"sftpgo": "/roots/sftpgo"}


def test_parse_glob_list_trims_and_drops_empty_entries() -> None:
    assert parse_glob_list(" A/**, ,B/** ") == ("A/**", "B/**")


def test_parse_glob_list_empty_string() -> None:
    assert parse_glob_list("") == ()


def test_config_treats_an_empty_ocr_exclude_globs_the_same_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # A compose passthrough of `${OCR_EXCLUDE_GLOBS:-}` always sets the env
    # var, just empty when the operator leaves it unset in .env; this must
    # not silently disable the default exclude list.
    monkeypatch.setenv("OCR_EXCLUDE_GLOBS", "")
    cfg = Config()
    assert cfg.default_exclude_globs == DEFAULT_EXCLUDE_GLOBS


def test_config_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INDEX_ROOTS", raising=False)
    monkeypatch.delenv("OCR_RUN_ON_START", raising=False)
    monkeypatch.delenv("OCR_INCLUDE_GLOBS", raising=False)
    cfg = Config()
    assert cfg.roots == {}
    assert cfg.ocr_port == 8011
    assert cfg.state_dir == "/state"
    assert cfg.run_on_start is True
    assert cfg.timeout_seconds == 900
    assert cfg.jobs == 2
    assert cfg.default_hour == 3
    assert cfg.default_langs == "swe+eng"
    assert cfg.default_exclude_globs == ("Programs/**", "Photos/**", "Videos/**")
    assert cfg.include_globs == ()
    assert cfg.default_max_mb == 200
    assert cfg.default_keep_originals is True


def test_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INDEX_ROOTS", "sftpgo=/roots/sftpgo")
    monkeypatch.setenv("OCR_PORT", "9000")
    monkeypatch.setenv("OCR_RUN_ON_START", "false")
    monkeypatch.setenv("OCR_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("OCR_JOBS", "4")
    monkeypatch.setenv("OCR_HOUR", "5")
    monkeypatch.setenv("OCR_LANGS", "eng")
    monkeypatch.setenv("OCR_EXCLUDE_GLOBS", "A/**,B/**")
    monkeypatch.setenv("OCR_INCLUDE_GLOBS", "fredrik/**, alice/**")
    monkeypatch.setenv("OCR_MAX_MB", "50")
    monkeypatch.setenv("OCR_KEEP_ORIGINALS", "false")
    cfg = Config()
    assert cfg.roots == {"sftpgo": "/roots/sftpgo"}
    assert cfg.ocr_port == 9000
    assert cfg.run_on_start is False
    assert cfg.timeout_seconds == 60
    assert cfg.jobs == 4
    assert cfg.default_hour == 5
    assert cfg.default_langs == "eng"
    assert cfg.default_exclude_globs == ("A/**", "B/**")
    assert cfg.include_globs == ("fredrik/**", "alice/**")
    assert cfg.default_max_mb == 50
    assert cfg.default_keep_originals is False


def test_config_default_settings_matches_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCR_HOUR", "7")
    cfg = Config()
    settings = cfg.default_settings()
    assert settings.hour == 7
    assert settings.langs == cfg.default_langs
    assert settings.exclude_globs == cfg.default_exclude_globs
    assert settings.max_mb == cfg.default_max_mb
    assert settings.keep_originals == cfg.default_keep_originals


def test_legacy_features_keep_nightly_pdf_ocr_when_startup_pass_is_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCR_RUN_ON_START", "false")
    assert Config().legacy_features().pdf_ocr is True
