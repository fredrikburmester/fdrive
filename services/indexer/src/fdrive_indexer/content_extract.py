"""Ephemeral extraction of provider-authorized bytes; never resolves storage paths."""
from __future__ import annotations

import threading
from tempfile import NamedTemporaryFile

from .chunking import is_image, is_textual
from .chunking import normalize as normalize_text
from .config import Config
from .extract import Extractor
from .paths import ext_of

MAX_CONTENT_BYTES = 4 * 1024 * 1024


class ContentExtractor:
    def __init__(self, cfg: Config) -> None:
        self.admission = threading.BoundedSemaphore(2)
        self.extractor = Extractor(
            root="mcp", text_max_bytes=MAX_CONTENT_BYTES, image_max_bytes=MAX_CONTENT_BYTES,
            max_pdf_pages=cfg.max_pdf_pages, plain_text_cap=cfg.plain_text_cap,
            tesseract_langs=cfg.default_settings().tesseract_langs, ocr_image_globs=["*"],
            tika_url=cfg.tika_url, normalize=normalize_text,
        )

    def extract(self, content: bytes, name: str, *, search_ocr: bool) -> dict[str, object]:
        ext = ext_of(name)
        if is_image(ext) and not search_ocr:
            return {"text": None, "status": "disabled"}
        if not is_textual(ext):
            return {"text": None, "status": "none"}
        with NamedTemporaryFile() as temporary:
            temporary.write(content)
            temporary.flush()
            text, status = self.extractor.extract(temporary.name, name, ext, len(content), search_ocr=search_ocr)
        # Extractor errors can contain local temporary paths; do not return those.
        return {"text": text, "status": "error" if status.startswith("error:") else status}
