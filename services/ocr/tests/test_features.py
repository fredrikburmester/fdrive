from fdrive_ocr.features import FEATURES_KEY, FeatureValues, resolve_features

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


def test_valid_contract_accepts_all_toggles_and_revision() -> None:
    parsed = resolve_features({FEATURES_KEY: _value(searchOcr=True)}, LEGACY, True)
    assert parsed.revision == 4
    assert parsed.values.search_ocr is True
    assert parsed.values.pdf_ocr is True


def test_invalid_contract_never_enables_managed_pdf_rewrites() -> None:
    for value in (
        None,
        {},
        {"version": 2, "revision": 1, "values": {}},
        {"version": 1, "revision": -1, "values": {}},
        {"version": 1, "revision": 1, "values": {"pdfOcr": "true"}},
    ):
        assert resolve_features({FEATURES_KEY: value}, LEGACY, True).values.pdf_ocr is False
