from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from fdrive_indexer import extract
from fdrive_indexer.chunking import normalize


def _write_pdf(path: Path, text: str, pages: int = 1) -> None:
    import pymupdf

    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), text)
    doc.save(str(path))
    doc.close()


def test_extract_pdf_returns_text(tmp_path: Path) -> None:
    pdf = tmp_path / "doc.pdf"
    _write_pdf(pdf, "Hello world, this is a pdf with more than forty characters of real text.")
    text, status = extract.extract_pdf(str(pdf), max_pages=600, normalize=normalize)
    assert status == "indexed"
    assert text is not None
    assert "Hello world" in text


def test_extract_pdf_short_text_is_no_text(tmp_path: Path) -> None:
    pdf = tmp_path / "blank.pdf"
    _write_pdf(pdf, "hi")
    text, status = extract.extract_pdf(str(pdf), max_pages=600, normalize=normalize)
    assert status == "no_text"
    assert text is None


def test_extract_pdf_respects_max_pages(tmp_path: Path) -> None:
    pdf = tmp_path / "multi.pdf"
    _write_pdf(pdf, "Page text repeated many times to be long enough for indexing purposes here.", pages=3)
    text, status = extract.extract_pdf(str(pdf), max_pages=1, normalize=normalize)
    assert status == "indexed"
    assert text is not None
    assert text.count("Page text") == 1


def test_extract_pdf_encrypted_returns_error(tmp_path: Path) -> None:
    import pymupdf

    pdf = tmp_path / "secret.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "top secret contents that nobody without the password should read")
    doc.save(str(pdf), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="owner")
    doc.close()
    text, status = extract.extract_pdf(str(pdf), max_pages=600, normalize=normalize)
    assert status == "error:encrypted"
    assert text is None


def test_extract_image_ocr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    img_path = tmp_path / "scan.png"
    Image.new("RGB", (100, 50), color="white").save(img_path)

    import pytesseract

    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "recognised text from the scan")
    text, status = extract.extract_image(str(img_path), langs="eng", normalize=normalize)
    assert status == "indexed"
    assert text == "recognised text from the scan"


def test_extract_image_short_text_is_no_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    img_path = tmp_path / "scan.png"
    Image.new("L", (10, 10)).save(img_path)

    import pytesseract

    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "hi")
    text, status = extract.extract_image(str(img_path), langs="eng", normalize=normalize)
    assert status == "no_text"
    assert text is None


def test_extract_image_converts_non_rgb_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    img_path = tmp_path / "scan.png"
    Image.new("RGBA", (100, 50), color=(255, 255, 255, 128)).save(img_path)

    import pytesseract

    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "recognised text from an rgba scan")
    text, status = extract.extract_image(str(img_path), langs="eng", normalize=normalize)
    assert status == "indexed"
    assert text == "recognised text from an rgba scan"


def test_extract_plain_reads_utf8(tmp_path: Path) -> None:
    p = tmp_path / "notes.txt"
    p.write_text("hello\r\nworld", encoding="utf-8")
    text, status = extract.extract_plain(str(p), cap=1000, normalize=normalize)
    assert status == "indexed"
    assert text == "hello\nworld"


def test_extract_plain_empty_file(tmp_path: Path) -> None:
    p = tmp_path / "empty.txt"
    p.write_bytes(b"")
    text, status = extract.extract_plain(str(p), cap=1000, normalize=normalize)
    assert status == "empty"
    assert text is None


def test_extract_plain_latin1_fallback(tmp_path: Path) -> None:
    p = tmp_path / "latin.txt"
    p.write_bytes("café".encode("latin-1"))
    text, status = extract.extract_plain(str(p), cap=1000, normalize=normalize)
    assert status == "indexed"
    assert text is not None


def test_extract_plain_truncates_to_cap(tmp_path: Path) -> None:
    p = tmp_path / "long.txt"
    p.write_text("a" * 5000, encoding="utf-8")
    text, _status = extract.extract_plain(str(p), cap=100, normalize=normalize)
    assert text is not None
    assert len(text) <= 100


def test_extract_tika_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "doc.docx"
    p.write_bytes(b"fake docx bytes")

    def fake_put(url: str, **kwargs: object) -> httpx.Response:
        return httpx.Response(
            200, text="extracted document text long enough to pass the threshold", request=httpx.Request("PUT", url)
        )

    monkeypatch.setattr(extract.httpx, "put", fake_put)
    text, status = extract.extract_tika(str(p), tika_url="http://tika:9998", normalize=normalize)
    assert status == "indexed"
    assert text is not None


def test_extract_tika_unsupported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "doc.docx"
    p.write_bytes(b"bytes")
    monkeypatch.setattr(extract.httpx, "put", lambda url, **kw: httpx.Response(422, request=httpx.Request("PUT", url)))
    text, status = extract.extract_tika(str(p), tika_url="http://tika:9998", normalize=normalize)
    assert status == "error:unsupported"
    assert text is None


def test_extract_tika_short_text_is_no_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "doc.docx"
    p.write_bytes(b"bytes")
    monkeypatch.setattr(extract.httpx, "put", lambda url, **kw: httpx.Response(200, text="hi", request=httpx.Request("PUT", url)))
    text, status = extract.extract_tika(str(p), tika_url="http://tika:9998", normalize=normalize)
    assert status == "no_text"
    assert text is None


def test_extract_tika_raises_for_server_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "doc.docx"
    p.write_bytes(b"bytes")
    monkeypatch.setattr(extract.httpx, "put", lambda url, **kw: httpx.Response(500, request=httpx.Request("PUT", url)))
    with pytest.raises(httpx.HTTPStatusError):
        extract.extract_tika(str(p), tika_url="http://tika:9998", normalize=normalize)


def _make_extractor(tmp_path: Path, **overrides: object) -> extract.Extractor:
    kwargs = dict(
        root="sftpgo",
        text_max_bytes=1_000_000,
        image_max_bytes=1_000_000,
        max_pdf_pages=600,
        plain_text_cap=300_000,
        tesseract_langs="eng",
        ocr_image_globs=["sftpgo/Documents/*"],
        tika_url="http://tika:9998",
        normalize=normalize,
    )
    kwargs.update(overrides)
    return extract.Extractor(**kwargs)  # type: ignore[arg-type]


def test_extractor_plain_text(tmp_path: Path) -> None:
    p = tmp_path / "readme.md"
    p.write_text("# Title\n\nBody text", encoding="utf-8")
    extractor = _make_extractor(tmp_path)
    text, status = extractor.extract(str(p), "readme.md", ".md", p.stat().st_size)
    assert status == "indexed"
    assert text is not None


def test_extractor_pdf_too_big(tmp_path: Path) -> None:
    p = tmp_path / "big.pdf"
    p.write_bytes(b"x")
    extractor = _make_extractor(tmp_path, text_max_bytes=0)
    text, status = extractor.extract(str(p), "big.pdf", ".pdf", 100)
    assert status == "excluded:too_big"
    assert text is None


def test_extractor_image_outside_ocr_dirs_excluded(tmp_path: Path) -> None:
    p = tmp_path / "photo.png"
    p.write_bytes(b"x")
    extractor = _make_extractor(tmp_path, ocr_image_globs=["sftpgo/Documents/*"])
    text, status = extractor.extract(str(p), "Photos/photo.png", ".png", 10)
    assert status == "excluded:image_dir"
    assert text is None


def test_extractor_image_too_big(tmp_path: Path) -> None:
    p = tmp_path / "scan.png"
    p.write_bytes(b"x")
    extractor = _make_extractor(tmp_path, ocr_image_globs=["sftpgo/*"], image_max_bytes=0)
    text, status = extractor.extract(str(p), "scan.png", ".png", 100)
    assert status == "excluded:too_big"
    assert text is None


def test_extractor_tika_too_big(tmp_path: Path) -> None:
    p = tmp_path / "doc.docx"
    p.write_bytes(b"x")
    extractor = _make_extractor(tmp_path, text_max_bytes=0)
    text, status = extractor.extract(str(p), "doc.docx", ".docx", 100)
    assert status == "excluded:too_big"
    assert text is None


def test_extractor_pdf_success(tmp_path: Path) -> None:
    pdf = tmp_path / "doc.pdf"
    _write_pdf(pdf, "Extractor-driven pdf text long enough to clear the forty character floor.")
    extractor = _make_extractor(tmp_path)
    text, status = extractor.extract(str(pdf), "doc.pdf", ".pdf", pdf.stat().st_size)
    assert status == "indexed"
    assert text is not None


def test_extractor_image_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    img = tmp_path / "Documents" / "scan.png"
    img.parent.mkdir()
    Image.new("RGB", (50, 50), color="white").save(img)

    import pytesseract

    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "ocr text through the extractor class")
    extractor = _make_extractor(tmp_path, ocr_image_globs=["sftpgo/Documents/*"])
    text, status = extractor.extract(str(img), "Documents/scan.png", ".png", img.stat().st_size)
    assert status == "indexed"
    assert text is not None


def test_extractor_tika_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    doc = tmp_path / "doc.docx"
    doc.write_bytes(b"fake docx bytes")
    monkeypatch.setattr(
        extract.httpx,
        "put",
        lambda url, **kw: httpx.Response(
            200, text="tika text through the extractor class is long enough", request=httpx.Request("PUT", url)
        ),
    )
    extractor = _make_extractor(tmp_path)
    text, status = extractor.extract(str(doc), "doc.docx", ".docx", doc.stat().st_size)
    assert status == "indexed"
    assert text is not None


def test_extractor_unknown_extension_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "app.bin"
    p.write_bytes(b"x")
    extractor = _make_extractor(tmp_path)
    text, status = extractor.extract(str(p), "app.bin", ".bin", 1)
    assert status == "none"
    assert text is None


def test_extractor_missing_file_returns_error(tmp_path: Path) -> None:
    extractor = _make_extractor(tmp_path)
    text, status = extractor.extract(str(tmp_path / "missing.md"), "missing.md", ".md", 1)
    assert status.startswith("error:")
    assert text is None


def test_extractor_excluded_by_prefix(tmp_path: Path) -> None:
    extractor = _make_extractor(tmp_path)
    assert extractor.excluded_by_prefix("Videos/movie.mp4", ["sftpgo/Videos/*"]) is True
    assert extractor.excluded_by_prefix("Docs/a.txt", ["sftpgo/Videos/*"]) is False


def test_embed_passages_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_post(url: str, json: dict[str, object], **kwargs: object) -> httpx.Response:
        inputs = json["inputs"]
        assert isinstance(inputs, list)
        calls.append(inputs)
        return httpx.Response(200, json=[[0.1, 0.2] for _ in inputs], request=httpx.Request("POST", url))

    monkeypatch.setattr(extract.httpx, "post", fake_post)
    vecs = extract.embed_passages(["a", "b", "c"], embed_url="http://embed:80", batch_size=2)
    assert len(vecs) == 3
    assert len(calls) == 2  # batched 2 + 1
    assert calls[0] == ["passage: a", "passage: b"]


def test_embed_query_uses_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_post(url: str, json: dict[str, object], **kwargs: object) -> httpx.Response:
        assert json["inputs"] == ["query: hello"]
        return httpx.Response(200, json=[[0.5]], request=httpx.Request("POST", url))

    monkeypatch.setattr(extract.httpx, "post", fake_post)
    vec = extract.embed_query("hello", embed_url="http://embed:80", batch_size=16)
    assert vec == [0.5]


def test_embed_health_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extract.httpx, "get", lambda url, timeout=5: httpx.Response(200))
    assert extract.embed_health("http://embed:80") is True


def test_embed_health_false_on_bad_status(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extract.httpx, "get", lambda url, timeout=5: httpx.Response(503))
    assert extract.embed_health("http://embed:80") is False


def test_embed_health_false_on_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_connect_error(url: str, timeout: int = 5) -> httpx.Response:
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(extract.httpx, "get", raise_connect_error)
    assert extract.embed_health("http://embed:80") is False
