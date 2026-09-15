from __future__ import annotations


def allow_large_png_metadata() -> None:
    """Pillow rejects a PNG whose compressed text or ICC chunk inflates past 1 MiB, which
    ordinary files in real libraries exceed. Each chunk stays capped at the 64 MiB Pillow
    already allows for all of a file's text together. The setting is process-wide, so call
    this before every `Image.open` that may read a PNG."""
    from PIL import PngImagePlugin

    PngImagePlugin.MAX_TEXT_CHUNK = PngImagePlugin.MAX_TEXT_MEMORY
