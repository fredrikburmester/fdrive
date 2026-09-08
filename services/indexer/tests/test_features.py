from fdrive_indexer.features import FEATURES_KEY, FeatureValues, resolve_features

LEGACY = FeatureValues(True, True, False, True, False, True)


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


def test_absent_row_preserves_legacy_or_disables_managed_install() -> None:
    assert resolve_features({}, LEGACY, False).values == LEGACY
    assert resolve_features({}, LEGACY, True).values.as_json() == {
        "thumbnails": False,
        "textSearch": False,
        "searchOcr": False,
        "semanticSearch": False,
        "imageSearch": False,
        "pdfOcr": False,
    }


def test_valid_contract_accepts_driver_json_and_exposes_revision() -> None:
    raw = {FEATURES_KEY: _value(imageSearch=True)}
    parsed = resolve_features(raw, LEGACY, True)
    assert parsed.revision == 4
    assert parsed.values.image_search is True
    assert parsed.values.internal_thumbnails is True
    assert parsed.values.indexer_enabled is True


def test_invalid_contract_falls_back_without_accidentally_starting_managed_work() -> None:
    for value in (
        None,
        {},
        {"version": 2, "revision": 1, "values": {}},
        {"version": 1, "revision": -1, "values": {}},
        {"version": 1, "revision": 1, "values": {"thumbnails": 1}},
    ):
        assert resolve_features({FEATURES_KEY: value}, LEGACY, True).values.indexer_enabled is False


def test_legacy_stored_ocr_scope_controls_admission() -> None:
    assert resolve_features({"indexer.ocr_image_globs": ["alice/scans/**"]}, LEGACY, False).values.search_ocr
    assert not resolve_features({"indexer.ocr_image_globs": []}, LEGACY, False).values.search_ocr
    assert not resolve_features({"indexer.ocr_image_globs": ["**"]}, LEGACY, True).values.search_ocr
