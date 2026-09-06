from fdrive_indexer.thumbs import (
    SIZES,
    kind_for_ext,
    resize_dimensions,
    should_skip_existing,
    storage_path,
    within_size_budget,
)


def test_sizes_constant() -> None:
    assert SIZES == (256, 1024)


def test_kind_for_ext_image() -> None:
    assert kind_for_ext(".png") == "image"


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
