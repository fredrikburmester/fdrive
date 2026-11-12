from fdrive_indexer.paths import (
    ext_of,
    is_junk_name,
    is_partial_upload,
    is_skip_dir,
    is_under,
    parent_dir,
    reindex_scope,
    root_relative_key,
)


def test_ext_of_simple() -> None:
    assert ext_of("report.PDF") == ".pdf"


def test_ext_of_tar_gz() -> None:
    assert ext_of("archive.tar.gz") == ".tar.gz"


def test_ext_of_none() -> None:
    assert ext_of("README") == ""


def test_is_junk_name_apple_double() -> None:
    assert is_junk_name("._foo.txt", frozenset({".DS_Store"})) is True


def test_is_junk_name_listed() -> None:
    assert is_junk_name(".DS_Store", frozenset({".DS_Store"})) is True


def test_is_junk_name_ordinary() -> None:
    assert is_junk_name("report.pdf", frozenset({".DS_Store"})) is False


def test_is_junk_name_unfinished_upload() -> None:
    assert is_junk_name(".fdrive-partial-00ff00ff00ff00ff", frozenset()) is True


def test_is_partial_upload_needs_the_exact_shape() -> None:
    assert is_partial_upload(".fdrive-partial-00ff00ff00ff00ff") is True
    assert is_partial_upload(".fdrive-partial-00ff00ff00ff00f") is False
    assert is_partial_upload(".fdrive-partial-00ff00ff00ff00ffx") is False


def test_is_skip_dir_true() -> None:
    assert is_skip_dir("node_modules", frozenset({"node_modules", ".git"})) is True


def test_is_skip_dir_false() -> None:
    assert is_skip_dir("Documents", frozenset({"node_modules"})) is False


def test_root_relative_key() -> None:
    assert root_relative_key("files", "Photos/a.png") == "files/Photos/a.png"


def test_parent_dir_nested() -> None:
    assert parent_dir("a/b/c.txt") == "a/b"


def test_parent_dir_top_level() -> None:
    assert parent_dir("c.txt") == ""


def test_is_under_root() -> None:
    assert is_under("a/b.txt", "") is True


def test_is_under_exact() -> None:
    assert is_under("a/b", "a/b") is True


def test_is_under_nested() -> None:
    assert is_under("a/b/c", "a/b") is True


def test_is_under_false_prefix_collision() -> None:
    assert is_under("a/bc", "a/b") is False


def test_reindex_scope_none() -> None:
    assert reindex_scope(None) == (None, None)


def test_reindex_scope_with_slashes() -> None:
    assert reindex_scope("/a/b/") == ("a/b", "a/b/")
