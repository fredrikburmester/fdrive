from pathlib import Path
from unittest.mock import Mock

import fitz
import pytest
from starlette.testclient import TestClient

from fdrive_indexer.config import Config
from fdrive_indexer.content_extract import MAX_CONTENT_BYTES, ContentExtractor
from fdrive_indexer.server import ServerState, create_app


def client_for(extractor: ContentExtractor | None) -> TestClient:
    state = ServerState(contexts={}, watchers={}, wake_events={}, conn_factory=Mock(), schema_version=lambda: None,
                        content_extractor=extractor)
    return TestClient(create_app(state))


def test_unindexed_pdf_and_text_round_trip() -> None:
    extractor = ContentExtractor(Config())
    client = client_for(extractor)
    document = fitz.open()
    document.new_page().insert_text((50, 50), "Provider-only document with enough text to extract for this test.")
    payload = document.tobytes()
    document.close()
    response = client.post("/extract-content?name=report.pdf", content=payload)
    assert response.status_code == 200
    assert "Provider-only document" in response.json()["text"]
    assert client.post("/extract-content?name=readme.txt", content=b"plain text").json()["text"] == "plain text"
    assert client.post("/extract-content?name=image.png", content=b"image").json()["status"] == "disabled"
    assert client.post("/extract-content?name=unknown.binary", content=b"x").json()["status"] == "none"


def test_extraction_bounds_and_admission() -> None:
    extractor = ContentExtractor(Config())
    client = client_for(extractor)
    assert client_for(None).post("/extract-content?name=a.txt", content=b"a").status_code == 503
    for name in ("", "../secret.txt", "a\\b", "a\x00", "a" * 256):
        assert client.post("/extract-content", params={"name": name}, content=b"a").status_code == 400
    assert client.post("/extract-content?name=a.txt", content=b"x" * (MAX_CONTENT_BYTES + 1)).status_code == 413
    extractor.admission.acquire()
    extractor.admission.acquire()
    try:
        assert client.post("/extract-content?name=a.txt", content=b"a").status_code == 429
    finally:
        extractor.admission.release()
        extractor.admission.release()
    assert client.post("/extract-content?name=a.txt", content=b"a").status_code == 200


def test_temporary_content_removed_and_errors_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    extractor = ContentExtractor(Config())
    paths = []

    def extract(path: str, *_args: object, **_kwargs: object) -> tuple[None, str]:
        paths.append(Path(path))
        assert Path(path).read_bytes() == b"office"
        return None, f"error: secret temporary path {path}"

    monkeypatch.setattr(extractor.extractor, "extract", extract)
    assert extractor.extract(b"office", "a.docx", search_ocr=False) == {"text": None, "status": "error"}
    assert all(not path.exists() for path in paths)
