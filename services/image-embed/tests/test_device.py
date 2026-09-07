from __future__ import annotations

from fdrive_image_embed.device import resolve_device


def test_explicit_cpu_passes_through_without_probing() -> None:
    calls = {"n": 0}

    def cuda_available() -> bool:
        calls["n"] += 1
        return True

    assert resolve_device("cpu", cuda_available) == "cpu"
    assert calls["n"] == 0


def test_explicit_cuda_is_case_insensitive() -> None:
    assert resolve_device("CUDA", lambda: False) == "cuda"


def test_auto_resolves_to_cuda_when_available() -> None:
    assert resolve_device("auto", lambda: True) == "cuda"


def test_auto_resolves_to_cpu_when_unavailable() -> None:
    assert resolve_device("auto", lambda: False) == "cpu"


def test_unrecognized_value_falls_back_to_autodetection() -> None:
    assert resolve_device("gpu", lambda: True) == "cuda"
    assert resolve_device("gpu", lambda: False) == "cpu"
