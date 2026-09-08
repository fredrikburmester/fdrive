from fdrive_indexer.config import Config, parse_roots


def test_parse_roots_multiple() -> None:
    assert parse_roots("sftpgo=/roots/sftpgo,photos=/roots/photos") == {
        "sftpgo": "/roots/sftpgo",
        "photos": "/roots/photos",
    }


def test_parse_roots_empty_string() -> None:
    assert parse_roots("") == {}


def test_parse_roots_skips_malformed_pairs() -> None:
    assert parse_roots("sftpgo=/roots/sftpgo,,broken,=novalue,noeq=") == {"sftpgo": "/roots/sftpgo"}


def test_config_defaults(monkeypatch) -> None:
    monkeypatch.delenv("INDEX_ROOTS", raising=False)
    monkeypatch.delenv("WATCH", raising=False)
    cfg = Config()
    assert cfg.roots == {}
    assert cfg.watch is True
    assert cfg.chunk_chars == 1200
    assert cfg.indexer_port == 8010


def test_config_reads_env(monkeypatch) -> None:
    monkeypatch.setenv("INDEX_ROOTS", "sftpgo=/roots/sftpgo")
    monkeypatch.setenv("WATCH", "false")
    monkeypatch.setenv("INDEX_WORKERS", "9")
    cfg = Config()
    assert cfg.roots == {"sftpgo": "/roots/sftpgo"}
    assert cfg.watch is False
    assert cfg.workers == 9


def test_config_default_settings_matches_env(monkeypatch) -> None:
    monkeypatch.setenv("INDEX_WORKERS", "3")
    cfg = Config()
    settings = cfg.default_settings()
    assert settings.workers == 3
    assert settings.scan_interval_seconds == cfg.scan_interval


def test_default_settings_allow_image_ocr_when_feature_is_enabled() -> None:
    assert Config().default_settings().ocr_image_globs == ("**",)


def test_config_image_embed_defaults_to_unconfigured(monkeypatch) -> None:
    monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)
    cfg = Config()
    assert cfg.image_embed_url == ""
    assert cfg.image_embed_batch_size == 8


def test_config_image_embed_reads_env(monkeypatch) -> None:
    monkeypatch.setenv("IMAGE_EMBED_URL", "http://image-embed:8012/")
    monkeypatch.setenv("IMAGE_EMBED_BATCH_SIZE", "4")
    cfg = Config()
    assert cfg.image_embed_url == "http://image-embed:8012"
    assert cfg.image_embed_batch_size == 4
