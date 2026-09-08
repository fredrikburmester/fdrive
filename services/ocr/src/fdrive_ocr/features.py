"""The persisted optional-feature contract used to admit source-writing OCR."""

from __future__ import annotations

import json
from dataclasses import dataclass

FEATURES_KEY = "features.configuration"
FEATURE_NAMES = ("thumbnails", "textSearch", "searchOcr", "semanticSearch", "imageSearch", "pdfOcr")


@dataclass(frozen=True)
class FeatureValues:
    thumbnails: bool
    text_search: bool
    search_ocr: bool
    semantic_search: bool
    image_search: bool
    pdf_ocr: bool

    def as_json(self) -> dict[str, bool]:
        return {
            "thumbnails": self.thumbnails,
            "textSearch": self.text_search,
            "searchOcr": self.search_ocr,
            "semanticSearch": self.semantic_search,
            "imageSearch": self.image_search,
            "pdfOcr": self.pdf_ocr,
        }


@dataclass(frozen=True)
class FeatureConfiguration:
    revision: int
    values: FeatureValues


def disabled() -> FeatureValues:
    return FeatureValues(False, False, False, False, False, False)


def _decode(value: object) -> object:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def resolve_features(raw: dict[str, object], legacy: FeatureValues, managed: bool) -> FeatureConfiguration:
    fallback = disabled() if managed else legacy
    value = _decode(raw.get(FEATURES_KEY))
    if not isinstance(value, dict) or value.get("version") != 1:
        return FeatureConfiguration(0, fallback)
    revision, values = value.get("revision"), value.get("values")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0 or not isinstance(values, dict):
        return FeatureConfiguration(0, fallback)
    parsed: list[bool] = []
    for name in FEATURE_NAMES:
        enabled = values.get(name)
        if not isinstance(enabled, bool):
            return FeatureConfiguration(0, fallback)
        parsed.append(enabled)
    return FeatureConfiguration(revision, FeatureValues(*parsed))
