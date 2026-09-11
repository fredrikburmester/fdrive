from __future__ import annotations

import functools


@functools.cache
def register_heif_opener() -> None:
    """Idempotently register pillow-heif's opener with Pillow so Image.open handles HEIC/HEIF."""
    import pillow_heif

    pillow_heif.register_heif_opener()
