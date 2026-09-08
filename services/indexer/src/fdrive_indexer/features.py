"""Versioned optional-processing configuration shared through ``app.settings``.

Workers deliberately parse defensively: the API owns validation, but a malformed
or unavailable row must never cause background processing to start unexpectedly.
"""

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

    @property
    def indexer_enabled(self) -> bool:
        return self.thumbnails or self.text_search or self.image_search

    @property
    def internal_thumbnails(self) -> bool:
        return self.thumbnails or self.image_search

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


def resolve_features(raw: dict[str, object]) -> FeatureConfiguration:
    """Resolve the persisted contract; absent or malformed state is all-off."""
    value = _decode(raw.get(FEATURES_KEY))
    if not isinstance(value, dict) or value.get("version") != 1:
        return FeatureConfiguration(0, disabled())
    revision = value.get("revision")
    values = value.get("values")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0 or not isinstance(values, dict):
        return FeatureConfiguration(0, disabled())
    parsed: list[bool] = []
    for name in FEATURE_NAMES:
        enabled = values.get(name)
        if not isinstance(enabled, bool):
            return FeatureConfiguration(0, disabled())
        parsed.append(enabled)
    return FeatureConfiguration(revision, FeatureValues(*parsed))
