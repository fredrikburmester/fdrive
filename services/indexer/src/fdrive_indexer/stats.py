"""Pure shaping of the `/health` and `/stats` response bodies from data the I/O layer
(`db.py`, `server.py`) already fetched. No querying here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RootStats:
    root: str
    counts_by_status: dict[str, int]
    chunks: int
    chunks_embedded: int
    last_scan: dict[str, Any] | None = None


def shape_health(
    roots: list[str],
    watcher: dict[str, bool],
    embed_ok: bool,
    schema_version: int | None,
) -> dict[str, Any]:
    return {
        "ok": schema_version is not None,
        "roots": list(roots),
        "watcher": dict(watcher),
        "embed_ok": embed_ok,
        "schema_version": schema_version,
    }


def shape_stats(
    per_root: list[RootStats],
    thumbnails_count: int,
    queue_depth: int,
    errors_sample: list[dict[str, Any]] | None = None,
    thumbnail_rebuild: dict[str, Any] | None = None,
    image_embeddings_count: int = 0,
    image_embedding_rebuild: dict[str, Any] | None = None,
) -> dict[str, Any]:
    errors_sample = errors_sample if errors_sample is not None else []
    return {
        "roots": [
            {
                "root": r.root,
                "counts_by_status": dict(r.counts_by_status),
                "chunks": r.chunks,
                "chunks_embedded": r.chunks_embedded,
                "last_scan": r.last_scan,
            }
            for r in per_root
        ],
        "thumbnails": thumbnails_count,
        "image_embeddings": image_embeddings_count,
        "queue_depth": queue_depth,
        "errors_sample": list(errors_sample),
        "thumbnail_rebuild": thumbnail_rebuild,
        "image_embedding_rebuild": image_embedding_rebuild,
    }
