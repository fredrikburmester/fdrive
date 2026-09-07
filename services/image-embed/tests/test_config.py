from __future__ import annotations

import pytest

from fdrive_image_embed.config import Config, _parse_threads


def test_parse_threads_none_when_unset() -> None:
    assert _parse_threads(None) is None


def test_parse_threads_none_when_blank() -> None:
    assert _parse_threads("  ") is None


def test_parse_threads_valid() -> None:
    assert _parse_threads("4") == 4


def test_parse_threads_falls_back_on_garbage() -> None:
    assert _parse_threads("not-a-number") is None


def test_config_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("IMAGE_EMBED_MODEL", raising=False)
    monkeypatch.delenv("IMAGE_EMBED_PORT", raising=False)
    monkeypatch.delenv("IMAGE_EMBED_BATCH_SIZE", raising=False)
    monkeypatch.delenv("IMAGE_EMBED_DEVICE", raising=False)
    monkeypatch.delenv("IMAGE_EMBED_THREADS", raising=False)
    monkeypatch.delenv("HF_HOME", raising=False)
    cfg = Config()
    assert cfg.model_id == "google/siglip2-large-patch16-256"
    assert cfg.port == 8012
    assert cfg.batch_size == 8
    assert cfg.device == "auto"
    assert cfg.threads is None
    assert cfg.hf_home == "/models"


def test_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_EMBED_MODEL", "some/other-model")
    monkeypatch.setenv("IMAGE_EMBED_PORT", "9000")
    monkeypatch.setenv("IMAGE_EMBED_BATCH_SIZE", "16")
    monkeypatch.setenv("IMAGE_EMBED_DEVICE", "cpu")
    monkeypatch.setenv("IMAGE_EMBED_THREADS", "2")
    monkeypatch.setenv("HF_HOME", "/data/models")
    cfg = Config()
    assert cfg.model_id == "some/other-model"
    assert cfg.port == 9000
    assert cfg.batch_size == 16
    assert cfg.device == "cpu"
    assert cfg.threads == 2
    assert cfg.hf_home == "/data/models"
