"""Image embedding I/O and the pure decisions around it: which files are
candidates, whether an existing row needs (re)writing, the dimension/status
guard against the sidecar's reported health, and the HTTP client that talks to
it. Entirely optional: an unset `IMAGE_EMBED_URL` means the caller never
reaches this module's I/O functions at all, mirroring how OCR and text
embedding degrade when their own sidecar is absent.

Follows `extract.py`'s `_embed`/`embed_health` shape for the HTTP client and
`thumbs.py`'s candidate-selection shape for what counts as an image.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .thumbs import MediaRow, is_thumbnail_candidate, kind_for_ext

# `vision_config.hidden_size` / `text_config.hidden_size` of
# google/siglip2-large-patch16-256, baked into `app.image_embeddings.embedding`'s
# column width (packages/db/drizzle). A sidecar reporting a different
# dimension is a hard stop for the rest of the run, never a truncation, a
# pad, or any other silent coercion.
IMAGE_EMBED_DIMENSIONS = 1024

# The sidecar's own HTTP contract rejects more than this many image parts in
# one `/embed/image` request (413); the client-side batcher below never
# exceeds it even if `IMAGE_EMBED_BATCH_SIZE` is configured higher.
MAX_IMAGES_PER_REQUEST = 32


@dataclass(frozen=True)
class ImageEmbedHealth:
    """A parsed `/embed`-sidecar `/health` response."""

    status: str
    model: str | None
    dim: int | None
    device: str | None


def parse_health(body: dict[str, Any]) -> ImageEmbedHealth:
    """Pure parsing of `/health`'s JSON body, tolerant of unexpected shapes
    (a malformed field falls back to a value that fails the dimension guard
    rather than raising)."""
    status = body.get("status")
    model = body.get("model")
    dim = body.get("dim")
    device = body.get("device")
    return ImageEmbedHealth(
        status=status if isinstance(status, str) else "loading",
        model=model if isinstance(model, str) else None,
        dim=dim if isinstance(dim, int) and not isinstance(dim, bool) else None,
        device=device if isinstance(device, str) else None,
    )


def image_embed_health(embed_url: str, timeout: float = 5) -> ImageEmbedHealth | None:
    """GETs `/health`. `None` means the sidecar could not be reached at all
    (connection refused, timeout, non-2xx) -- distinct from a reachable
    sidecar reporting `status: "loading"`, which `parse_health` returns."""
    try:
        r = httpx.get(f"{embed_url}/health", timeout=timeout)
        r.raise_for_status()
        return parse_health(r.json())
    except Exception:  # noqa: BLE001 - an unreachable sidecar must never raise
        return None


def dimension_guard(health: ImageEmbedHealth | None, expected_dim: int = IMAGE_EMBED_DIMENSIONS) -> str | None:
    """Checked once before writing any batch. `None` means the sidecar is
    healthy and reports exactly `expected_dim`; otherwise a message naming
    both the expected and the reported numbers (or the unreachable/loading
    state), for the caller to log and then skip embedding for the rest of
    the run without writing anything."""
    if health is None:
        return "image-embed sidecar unreachable"
    if health.status != "ok":
        return f"image-embed sidecar not ready (status={health.status})"
    if health.dim != expected_dim:
        return f"image-embed sidecar dimension mismatch: expected {expected_dim}, got {health.dim}"
    return None


def parse_embed_response(body: dict[str, Any]) -> tuple[list[list[float]], str]:
    """Pure parsing of `/embed/image` and `/embed/text`'s shared response
    shape: `{"model": ..., "dim": ..., "embeddings": [[...], ...]}`."""
    model = body.get("model")
    embeddings = body.get("embeddings")
    if not isinstance(model, str) or not isinstance(embeddings, list):
        raise ValueError("malformed image-embed response")
    return [[float(v) for v in vec] for vec in embeddings], model


def embed_images(
    image_bytes: Sequence[bytes],
    embed_url: str,
    batch_size: int,
    timeout: float = 60.0,
) -> tuple[list[list[float]], str]:
    """POSTs `image_bytes` to `/embed/image` in groups of at most
    `min(batch_size, MAX_IMAGES_PER_REQUEST)`, in request order. Returns the
    concatenated embeddings and the model id the sidecar reported (assumed
    stable across batches within one call, since a live sidecar never
    changes its loaded model)."""
    out: list[list[float]] = []
    model = ""
    step = max(1, min(batch_size, MAX_IMAGES_PER_REQUEST))
    for i in range(0, len(image_bytes), step):
        batch = image_bytes[i : i + step]
        files = [("images", (f"{i + j}.bin", data, "application/octet-stream")) for j, data in enumerate(batch)]
        r = httpx.post(f"{embed_url}/embed/image", files=files, timeout=httpx.Timeout(timeout, connect=10.0))
        r.raise_for_status()
        embeddings, model = parse_embed_response(r.json())
        out.extend(embeddings)
    return out, model


def is_image_candidate(ext: str) -> bool:
    """Whether `ext` is an embeddable image, i.e. the same extension set
    that earns a thumbnail with `kind == "image"` (never a PDF or video
    first frame). Used by the live per-file indexer pass, which has no
    scope to filter by."""
    return kind_for_ext(ext) == "image"


def is_image_embed_candidate(ext: str, rel_path: str, scope: str) -> bool:
    """`is_image_candidate` plus the same scope check `thumbs.py` uses,
    for the bulk rebuild pass over a (sub)tree."""
    return is_image_candidate(ext) and is_thumbnail_candidate(ext, rel_path, scope)


def select_image_embed_candidates(rows: Sequence[MediaRow], scope: str) -> list[MediaRow]:
    """Filter live file rows down to the ones an image-embedding pass should
    touch: an image extension, under `scope`."""
    return [row for row in rows if is_image_embed_candidate(row[1], row[0], scope)]


def needs_embedding(existing_model: str | None, configured_model: str) -> bool:
    """The live indexer pass's per-file decision, run right after a
    thumbnail is written: skip only when the file already has a row for the
    currently configured model. No row yet, or a row from a different
    (stale) model, is always (re)embedded, so a model change self-heals as
    files are next touched."""
    return existing_model != configured_model


def rebuild_needs_embedding(existing_model: str | None, configured_model: str, force: bool) -> bool:
    """The bulk rebuild pass's per-candidate decision. Without `force`, only
    a content key with no row at all is filled in; a row already present --
    even one written by a different model -- is left alone, so a rebuild
    triggered for an unrelated reason (e.g. new images added since the last
    scan) never silently reinterprets the whole library. With `force`, a
    stale-model row is also re-embedded and overwritten with the configured
    model -- the deliberate "replace the old model's rows" pass. A row that
    already matches the configured model is never redundantly recomputed
    either way."""
    if existing_model is None:
        return True
    if existing_model == configured_model:
        return False
    return force
