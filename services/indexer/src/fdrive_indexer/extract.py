"""Text extraction and embedding I/O. Returns (text, status); never raises for a bad
file, mirroring filesai: a single bad file must never stop the scan.

status is one of: indexed | no_text | empty | none | error:<reason> | excluded:<reason>.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from .chunking import is_image, is_pdf, is_plain, is_tika
from .rules import is_ocr_image_dir, is_text_excluded

Normalizer = Callable[[str], str]


def extract_pdf(abs_path: str, max_pages: int, normalize: Normalizer) -> tuple[str | None, str]:
    import pymupdf

    pymupdf.TOOLS.mupdf_display_errors(False)
    parts: list[str] = []
    with pymupdf.open(abs_path) as doc:
        if doc.needs_pass:
            return None, "error:encrypted"
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            parts.append(page.get_text("text"))
    text = normalize("\n\n".join(parts))
    if len(text) < 40:
        return None, "no_text"
    return text, "indexed"


def extract_image(abs_path: str, langs: str, normalize: Normalizer) -> tuple[str | None, str]:
    import pytesseract
    from PIL import Image, ImageOps

    with Image.open(abs_path) as opened:
        picture: Image.Image = ImageOps.exif_transpose(opened) or opened
        if picture.mode not in ("L", "RGB"):
            picture = picture.convert("RGB")
        picture.thumbnail((3000, 3000))
        text = pytesseract.image_to_string(picture, lang=langs, timeout=180)
    text = normalize(text)
    if len(text) < 20:
        return None, "no_text"
    return text, "indexed"


def extract_plain(abs_path: str, cap: int, normalize: Normalizer) -> tuple[str | None, str]:
    with open(abs_path, "rb") as fh:
        raw = fh.read(cap * 2)
    for enc in ("utf-8", "utf-16", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - latin-1 maps every byte, so this branch is unreachable
        text = raw.decode("utf-8", errors="replace")
    text = normalize(text)[:cap]
    return (text, "indexed") if text else (None, "empty")


def extract_tika(abs_path: str, tika_url: str, normalize: Normalizer) -> tuple[str | None, str]:
    with open(abs_path, "rb") as fh:
        r = httpx.put(
            f"{tika_url}/tika",
            content=fh,
            headers={"Accept": "text/plain", "X-Tika-Skip-Embedded": "false"},
            timeout=httpx.Timeout(180.0, connect=10.0),
        )
    if r.status_code == 422:
        return None, "error:unsupported"
    r.raise_for_status()
    text = normalize(r.text)
    if len(text) < 20:
        return None, "no_text"
    return text, "indexed"


class Extractor:
    """Bundles the config knobs extraction needs so call sites do not thread a dozen
    arguments through every function."""

    def __init__(
        self,
        *,
        root: str,
        text_max_bytes: int,
        image_max_bytes: int,
        max_pdf_pages: int,
        plain_text_cap: int,
        tesseract_langs: str,
        ocr_image_globs: list[str],
        tika_url: str,
        normalize: Normalizer,
    ) -> None:
        self.root = root
        self.text_max_bytes = text_max_bytes
        self.image_max_bytes = image_max_bytes
        self.max_pdf_pages = max_pdf_pages
        self.plain_text_cap = plain_text_cap
        self.tesseract_langs = tesseract_langs
        self.ocr_image_globs = ocr_image_globs
        self.tika_url = tika_url
        self.normalize = normalize

    def extract(self, abs_path: str, rel_path: str, ext: str, size: int) -> tuple[str | None, str]:
        try:
            if is_pdf(ext):
                if size > self.text_max_bytes:
                    return None, "excluded:too_big"
                return extract_pdf(abs_path, self.max_pdf_pages, self.normalize)
            if is_image(ext):
                if not is_ocr_image_dir(self.root, rel_path, self.ocr_image_globs):
                    return None, "excluded:image_dir"
                if size > self.image_max_bytes:
                    return None, "excluded:too_big"
                return extract_image(abs_path, self.tesseract_langs, self.normalize)
            if is_plain(ext):
                return extract_plain(abs_path, self.plain_text_cap, self.normalize)
            if is_tika(ext):
                if size > self.text_max_bytes:
                    return None, "excluded:too_big"
                return extract_tika(abs_path, self.tika_url, self.normalize)
            return None, "none"
        except Exception as e:  # noqa: BLE001 - one bad file must never stop the scan
            return None, f"error:{type(e).__name__}: {str(e)[:200]}"

    def excluded_by_prefix(self, rel_path: str, text_exclude_globs: list[str]) -> bool:
        return is_text_excluded(self.root, rel_path, text_exclude_globs)


def embed_passages(texts: list[str], embed_url: str, batch_size: int) -> list[list[float]]:
    return _embed([f"passage: {t}" for t in texts], embed_url, batch_size)


def embed_query(text: str, embed_url: str, batch_size: int) -> list[float]:
    return _embed([f"query: {text}"], embed_url, batch_size)[0]


def _embed(inputs: list[str], embed_url: str, batch_size: int) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(inputs), batch_size):
        batch = inputs[i : i + batch_size]
        r = httpx.post(
            f"{embed_url}/embed",
            json={"inputs": batch, "truncate": True, "normalize": True},
            timeout=httpx.Timeout(600.0, connect=10.0),
        )
        r.raise_for_status()
        out.extend(r.json())
    return out


def embed_health(embed_url: str) -> bool:
    try:
        return httpx.get(f"{embed_url}/health", timeout=5).status_code == 200
    except Exception:  # noqa: BLE001
        return False
