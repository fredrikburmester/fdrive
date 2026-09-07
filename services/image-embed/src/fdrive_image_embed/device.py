"""Pure device resolution. `IMAGE_EMBED_DEVICE=auto` (the default) becomes
"cuda" when CUDA is available and "cpu" otherwise; an explicit "cpu" or "cuda"
(any case) passes straight through without probing. The CUDA-availability
check is taken as an argument rather than called directly, so this module
never has to import torch and stays testable without it.
"""

from __future__ import annotations

from collections.abc import Callable

VALID_DEVICES = ("cpu", "cuda")


def resolve_device(requested: str, cuda_available: Callable[[], bool]) -> str:
    normalized = requested.strip().lower()
    if normalized in VALID_DEVICES:
        return normalized
    # "auto" and anything else unrecognized both fall back to autodetection,
    # so a typo degrades to "best effort" rather than crashing startup.
    return "cuda" if cuda_available() else "cpu"
