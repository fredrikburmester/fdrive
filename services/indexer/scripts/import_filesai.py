#!/usr/bin/env python3
"""One-shot migration of an old filesai Postgres database into fdrive's `idx`
schema, under a single named root, so nothing needs to be re-extracted or
re-embedded (the embedding model, `intfloat/multilingual-e5-small`, is
unchanged between filesai and fdrive).

Usage:
    python scripts/import-filesai.py \\
        --source "host=old-db port=5432 dbname=filesai user=filesai password=..." \\
        --target "$DATABASE_URL" \\
        --root sftpgo

Idempotent: rows are upserted on (root_id, path), so running it twice against
the same source and target the second time updates nothing new.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from typing import Any, Protocol


class Cursor(Protocol):
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Any: ...
    def fetchall(self) -> list[tuple[Any, ...]]: ...
    def fetchone(self) -> tuple[Any, ...] | None: ...


@dataclass(frozen=True)
class FilesaiFile:
    """One row from filesai's `files` table, the columns this import needs."""

    path: str
    name: str
    ext: str
    size: int
    mtime_ns: int
    sha256: str | None
    mime: str | None
    text_status: str
    text_chars: int
    error: str | None


@dataclass(frozen=True)
class FilesaiChunk:
    """One row from filesai's `chunks` table."""

    file_path: str
    idx: int
    text: str
    embedding: list[float] | None


def map_file_row(row: dict[str, Any]) -> FilesaiFile:
    """Map one raw `files` row (as a dict, whatever the driver returns) onto the
    subset of columns fdrive's `idx.files` also has. Pure: no DB access."""
    return FilesaiFile(
        path=row["path"],
        name=row["name"],
        ext=row.get("ext") or "",
        size=int(row["size"]),
        mtime_ns=int(row["mtime_ns"]),
        sha256=row.get("sha256"),
        mime=row.get("mime"),
        text_status=row.get("text_status") or "pending",
        text_chars=int(row.get("text_chars") or 0),
        error=row.get("error"),
    )


def map_chunk_row(row: dict[str, Any], file_path: str) -> FilesaiChunk:
    """Map one raw `chunks` row. `file_path` is resolved by the caller from the
    old row's `file_id` via the files table, since chunk rows in fdrive's schema
    are keyed by the new `file_id`, not the old one."""
    return FilesaiChunk(
        file_path=file_path,
        idx=int(row["idx"]),
        text=row["text"],
        embedding=row.get("embedding"),
    )


def import_files(
    source_cur: Cursor,
    target_cur: Cursor,
    root_id: int,
) -> dict[str, int]:
    """Copy every `files` row and its `chunks` from `source_cur` into
    `target_cur` under `root_id`. Returns `{"files": n, "chunks": n}`."""
    source_cur.execute("SELECT id, path, name, ext, size, mtime_ns, sha256, mime, text_status, text_chars, error FROM files")
    columns = ["id", "path", "name", "ext", "size", "mtime_ns", "sha256", "mime", "text_status", "text_chars", "error"]
    file_rows = [dict(zip(columns, row, strict=True)) for row in source_cur.fetchall()]

    files_imported = 0
    chunks_imported = 0
    for raw in file_rows:
        mapped = map_file_row(raw)
        target_cur.execute(
            """
            INSERT INTO "idx"."files"
              (root_id, path, name, ext, size, mtime_ns, sha256, mime, text_status, text_chars, error, first_seen, last_seen)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            ON CONFLICT (root_id, path) DO UPDATE SET
              name = EXCLUDED.name, ext = EXCLUDED.ext, size = EXCLUDED.size, mtime_ns = EXCLUDED.mtime_ns,
              sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime, text_status = EXCLUDED.text_status,
              text_chars = EXCLUDED.text_chars, error = EXCLUDED.error
            RETURNING id
            """,
            (
                root_id,
                mapped.path,
                mapped.name,
                mapped.ext,
                mapped.size,
                mapped.mtime_ns,
                mapped.sha256,
                mapped.mime,
                mapped.text_status,
                mapped.text_chars,
                mapped.error,
            ),
        )
        target_row = target_cur.fetchone()
        assert target_row is not None
        new_file_id = target_row[0]
        files_imported += 1

        source_cur.execute("SELECT idx, text, embedding FROM chunks WHERE file_id = %s ORDER BY idx", (raw["id"],))
        chunk_columns = ["idx", "text", "embedding"]
        target_cur.execute('DELETE FROM "idx"."chunks" WHERE file_id = %s', (new_file_id,))
        for chunk_raw in source_cur.fetchall():
            chunk = map_chunk_row(dict(zip(chunk_columns, chunk_raw, strict=True)), mapped.path)
            target_cur.execute(
                'INSERT INTO "idx"."chunks" (file_id, idx, text, embedding) VALUES (%s, %s, %s, %s)',
                (new_file_id, chunk.idx, chunk.text, chunk.embedding),
            )
            chunks_imported += 1

    return {"files": files_imported, "chunks": chunks_imported}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="psycopg DSN for the old filesai database")
    parser.add_argument("--target", required=True, help="psycopg DSN for the fdrive database")
    parser.add_argument("--root", required=True, help="root name to import under, e.g. sftpgo")
    args = parser.parse_args(argv)

    import psycopg

    with psycopg.connect(args.source) as source_conn, psycopg.connect(args.target) as target_conn:
        with source_conn.cursor() as source_cur, target_conn.cursor() as target_cur:
            target_cur.execute(
                'INSERT INTO "idx"."roots" (name) VALUES (%s) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
                (args.root,),
            )
            row = target_cur.fetchone()
            assert row is not None
            root_id = row[0]
            counts = import_files(source_cur, target_cur, root_id)
        target_conn.commit()

    print(f"imported {counts['files']} files and {counts['chunks']} chunks into root '{args.root}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
