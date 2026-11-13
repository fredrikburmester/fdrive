from fdrive_indexer.rules import (
    is_ocr_image_dir,
    is_text_excluded,
    matches_any_glob,
    should_index_name,
    should_walk_dir,
    split_prefixes,
    under_prefix,
)


def test_split_prefixes_trims_and_drops_empty() -> None:
    assert split_prefixes("Photos, /Videos/Raw/ ,,") == ["Photos", "Videos/Raw"]


def test_split_prefixes_empty_string() -> None:
    assert split_prefixes("") == []


def test_under_prefix_exact() -> None:
    assert under_prefix("Photos", ["Photos"]) is True


def test_under_prefix_nested() -> None:
    assert under_prefix("Photos/2024/a.jpg", ["Photos"]) is True


def test_under_prefix_false() -> None:
    assert under_prefix("PhotosArchive/a.jpg", ["Photos"]) is False


def test_matches_any_glob_true() -> None:
    assert matches_any_glob("files/Photos/a.jpg", ["files/Photos/*"]) is True


def test_matches_any_glob_false() -> None:
    assert matches_any_glob("files/Docs/a.jpg", ["files/Photos/*"]) is False


def test_is_text_excluded() -> None:
    assert is_text_excluded("files", "Videos/a.mp4", ["files/Videos/*"]) is True


def test_is_ocr_image_dir() -> None:
    assert is_ocr_image_dir("files", "Documents/scan.png", ["files/Documents/*"]) is True


def test_should_walk_dir_true() -> None:
    assert should_walk_dir("Documents", frozenset({".git"})) is True


def test_should_walk_dir_false() -> None:
    assert should_walk_dir(".git", frozenset({".git"})) is False


def test_should_index_name_true() -> None:
    assert should_index_name("report.pdf", frozenset({".DS_Store"})) is True


def test_should_index_name_apple_double() -> None:
    assert should_index_name("._report.pdf", frozenset({".DS_Store"})) is False


def test_should_index_name_skip_listed() -> None:
    assert should_index_name(".DS_Store", frozenset({".DS_Store"})) is False


def test_should_index_name_skips_an_unfinished_local_upload() -> None:
    assert should_index_name(".fdrive-partial-0123456789abcdef", frozenset()) is False


def test_should_index_name_keeps_names_that_only_resemble_an_upload() -> None:
    for name in (
        ".fdrive-partial-0123456789abcde",
        ".fdrive-partial-0123456789ABCDEF",
        ".fdrive-partial-0123456789abcdef.docx",
        "fdrive-partial-0123456789abcdef",
    ):
        assert should_index_name(name, frozenset()) is True
