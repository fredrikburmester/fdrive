from fdrive_indexer.features import FEATURES_KEY, resolve_features


def _value(**overrides: bool) -> dict[str, object]:
    values = {
        "thumbnails": True,
        "textSearch": True,
        "searchOcr": False,
        "semanticSearch": True,
        "imageSearch": False,
        "pdfOcr": True,
    }
    values.update(overrides)
    return {"version": 1, "revision": 4, "values": values}


def test_absent_row_disables_all_processing() -> None:
    assert resolve_features({}).values.as_json() == {
        "thumbnails": False,
        "textSearch": False,
        "searchOcr": False,
        "semanticSearch": False,
        "imageSearch": False,
        "pdfOcr": False,
    }


def test_valid_contract_accepts_driver_json_and_exposes_revision() -> None:
    raw = {FEATURES_KEY: _value(imageSearch=True)}
    parsed = resolve_features(raw)
    assert parsed.revision == 4
    assert parsed.values.image_search is True
    assert parsed.values.internal_thumbnails is True
    assert parsed.values.indexer_enabled is True


def test_invalid_contract_disables_all_processing() -> None:
    for value in (
        None,
        {},
        {"version": 2, "revision": 1, "values": {}},
        {"version": 1, "revision": -1, "values": {}},
        {"version": 1, "revision": 1, "values": {"thumbnails": 1}},
    ):
        assert resolve_features({FEATURES_KEY: value}).values.indexer_enabled is False


def test_unrelated_stored_settings_never_enable_features() -> None:
    assert not resolve_features({"indexer.ocr_image_globs": ["alice/scans/**"]}).values.search_ocr
