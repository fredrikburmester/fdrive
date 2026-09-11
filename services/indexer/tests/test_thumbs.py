from fdrive_indexer.thumbs import (
    SIZES,
    is_thumbnail_candidate,
    kind_for_ext,
    normalize_scope,
    resize_dimensions,
    select_candidates,
    should_regenerate,
    should_skip_existing,
    storage_path,
    within_size_budget,
)


def test_sizes_constant() -> None:
    assert SIZES == (256, 1024)


def test_kind_for_ext_image() -> None:
    assert kind_for_ext(".png") == "image"
    assert kind_for_ext(".heic") == "image"
    assert kind_for_ext(".heif") == "image"


def test_kind_for_ext_pdf() -> None:
    assert kind_for_ext(".pdf") == "pdf"


def test_kind_for_ext_video() -> None:
    assert kind_for_ext(".mp4") == "video"


def test_kind_for_ext_none() -> None:
    assert kind_for_ext(".txt") is None


def test_within_size_budget_true() -> None:
    assert within_size_budget(100, 200) is True


def test_within_size_budget_false() -> None:
    assert within_size_budget(300, 200) is False


def test_storage_path() -> None:
    sha = "abcdef0123456789"
    assert storage_path(sha, 256) == "ab/abcdef0123456789.256.webp"


def test_resize_dimensions_downscale_landscape() -> None:
    assert resize_dimensions(4000, 2000, 1024) == (1024, 512)


def test_resize_dimensions_downscale_portrait() -> None:
    assert resize_dimensions(2000, 4000, 1024) == (512, 1024)


def test_resize_dimensions_no_upscale() -> None:
    assert resize_dimensions(100, 50, 1024) == (100, 50)


def test_resize_dimensions_zero_dimension_guard() -> None:
    assert resize_dimensions(0, 10, 256) == (1, 10)
    assert resize_dimensions(10, 0, 256) == (10, 1)


def test_should_skip_existing_true() -> None:
    assert should_skip_existing(True) is True


def test_should_skip_existing_false() -> None:
    assert should_skip_existing(False) is False


def test_should_regenerate_forced_even_when_exists() -> None:
    assert should_regenerate(exists=True, force=True) is True


def test_should_regenerate_missing_without_force() -> None:
    assert should_regenerate(exists=False, force=False) is True


def test_should_regenerate_skips_existing_without_force() -> None:
    assert should_regenerate(exists=True, force=False) is False


def test_normalize_scope_none_is_whole_root() -> None:
    assert normalize_scope(None) == ""


def test_normalize_scope_strips_slashes() -> None:
    assert normalize_scope("/photos/2024/") == "photos/2024"


def test_is_thumbnail_candidate_wrong_extension() -> None:
    assert is_thumbnail_candidate(".txt", "notes.txt", "") is False


def test_is_thumbnail_candidate_whole_root_matches_anything() -> None:
    assert is_thumbnail_candidate(".png", "any/where.png", "") is True


def test_is_thumbnail_candidate_exact_path_match() -> None:
    assert is_thumbnail_candidate(".png", "photos/a.png", "photos/a.png") is True


def test_is_thumbnail_candidate_under_prefix() -> None:
    assert is_thumbnail_candidate(".png", "photos/2024/a.png", "photos") is True


def test_is_thumbnail_candidate_outside_prefix() -> None:
    assert is_thumbnail_candidate(".png", "docs/a.png", "photos") is False


def test_is_thumbnail_candidate_sibling_name_prefix_is_not_a_match() -> None:
    # "photos2/a.png" must not match scope "photos" just because it starts with
    # the same characters; only "photos" itself or "photos/..." should match.
    assert is_thumbnail_candidate(".png", "photos2/a.png", "photos") is False


def test_select_candidates_filters_extension_and_scope() -> None:
    rows = [
        ("photos/a.png", ".png", "sha1", 100),
        ("photos/a.txt", ".txt", "sha2", 50),
        ("docs/b.pdf", ".pdf", "sha3", 200),
    ]
    assert select_candidates(rows, "photos") == [("photos/a.png", ".png", "sha1", 100)]


def test_select_candidates_whole_root() -> None:
    rows = [
        ("photos/a.png", ".png", "sha1", 100),
        ("clip.mp4", ".mp4", "sha4", 300),
    ]
    assert select_candidates(rows, "") == rows
