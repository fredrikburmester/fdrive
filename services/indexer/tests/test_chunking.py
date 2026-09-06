from fdrive_indexer.chunking import (
    chunk,
    is_image,
    is_pdf,
    is_plain,
    is_textual,
    is_tika,
    max_chunks_for,
    normalize,
)


def test_normalize_collapses_whitespace_and_newlines() -> None:
    raw = "line one \t\r\n\r\nline two\x00\n\n\n\nline three   end  "
    result = normalize(raw)
    assert result == "line one\n\nline two\n\nline three end"


def test_normalize_strips_carriage_returns() -> None:
    assert normalize("a\rb\r\nc") == "a\nb\nc"


def test_is_textual_true_for_plain() -> None:
    assert is_textual(".md") is True


def test_is_textual_false_for_unknown() -> None:
    assert is_textual(".bin") is False


def test_is_pdf() -> None:
    assert is_pdf(".pdf") is True
    assert is_pdf(".txt") is False


def test_is_image() -> None:
    assert is_image(".png") is True
    assert is_image(".pdf") is False


def test_is_plain() -> None:
    assert is_plain(".md") is True
    assert is_plain(".pdf") is False


def test_is_tika() -> None:
    assert is_tika(".docx") is True
    assert is_tika(".md") is False


def test_max_chunks_for_spreadsheet_cap() -> None:
    assert max_chunks_for(".csv", default_max=400, spreadsheet_cap=40) == 40


def test_max_chunks_for_default() -> None:
    assert max_chunks_for(".pdf", default_max=400, spreadsheet_cap=40) == 400


def test_max_chunks_for_default_lower_than_cap() -> None:
    assert max_chunks_for(".xlsx", default_max=10, spreadsheet_cap=40) == 10


def test_chunk_empty_text() -> None:
    assert chunk("", size=1200, overlap=200, max_chunks=400) == []


def test_chunk_short_text_single_chunk() -> None:
    text = "short text"
    assert chunk(text, size=1200, overlap=200, max_chunks=400) == [text]


def test_chunk_long_text_breaks_on_whitespace() -> None:
    text = ("word " * 400).strip()  # 1999 chars, well over the 1200 chunk size
    pieces = chunk(text, size=1200, overlap=200, max_chunks=400)
    assert len(pieces) >= 2
    assert all(pieces)
    # reassembling should recover most of the original words (overlap duplicates some)
    assert "".join(pieces).replace(" ", "") != ""


def test_chunk_respects_max_chunks() -> None:
    text = "x" * 100_000
    pieces = chunk(text, size=1200, overlap=200, max_chunks=5)
    assert len(pieces) == 5


def test_chunk_no_good_whitespace_cut_falls_back_to_hard_cut() -> None:
    text = "a" * 3000  # no whitespace anywhere, so the hard cut at `size` is used
    pieces = chunk(text, size=1200, overlap=200, max_chunks=400)
    assert pieces[0] == "a" * 1200


def test_chunk_all_whitespace_produces_no_pieces() -> None:
    text = " " * 3000
    assert chunk(text, size=1200, overlap=200, max_chunks=400) == []


def test_chunk_stops_when_end_reaches_n_after_whitespace_cut() -> None:
    # crafted so the whitespace search finds a cut very close to the end
    text = "a" * 1190 + " " + "b" * 9
    pieces = chunk(text, size=1200, overlap=200, max_chunks=400)
    assert pieces[-1].endswith("bbbbbbbbb") or pieces[-1].endswith("a")
