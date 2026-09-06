"""All SQL. The indexer never creates tables: schema ownership lives in
`packages/db/drizzle/*.sql`. This module waits for the schema to exist, then reads
and writes the `idx` and `app` schemas the migrations define.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from typing import Any

import psycopg
from pgvector.psycopg import register_vector

from .events import Event, to_json
from .stats import RootStats


def connect(dsn: str, retries: int = 30, sleep: Callable[[float], None] = time.sleep) -> psycopg.Connection:
    last: Exception | None = None
    for _ in range(retries):
        try:
            conn = psycopg.connect(dsn, autocommit=True)
            register_vector(conn)
            return conn
        except psycopg.OperationalError as e:
            last = e
            sleep(2)
    raise RuntimeError(f"could not connect to postgres: {last}")


def wait_for_schema_version(
    conn: psycopg.Connection,
    expected: int,
    timeout_seconds: int,
    log: Callable[[str], None],
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> int | None:
    """Poll `idx.schema_version` until it reports `expected`. Returns the version
    seen when it matches, or `None` once `timeout_seconds` has elapsed."""
    deadline = now() + timeout_seconds
    while True:
        version = read_schema_version(conn)
        if version == expected:
            return version
        if now() >= deadline:
            log(f"schema_version never reached {expected} (last seen: {version}); giving up")
            return None
        log(f"waiting for idx.schema_version = {expected} (last seen: {version})")
        sleep(5)


def read_schema_version(conn: psycopg.Connection) -> int | None:
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT version FROM "idx"."schema_version" ORDER BY version DESC LIMIT 1')
            row = cur.fetchone()
            return int(row[0]) if row else None
    except psycopg.Error:
        conn.rollback()
        return None


def upsert_root(conn: psycopg.Connection, name: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "idx"."roots" (name) VALUES (%s) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            (name,),
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def get_manifest(conn: psycopg.Connection, root_id: int) -> dict[str, tuple[int, int, str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT path, size, mtime_ns, text_status, deleted_at FROM "idx"."files" WHERE root_id = %s',
            (root_id,),
        )
        return {r[0]: (r[1], r[2], r[3], r[4]) for r in cur.fetchall()}


def upsert_file(
    conn: psycopg.Connection,
    root_id: int,
    rel_path: str,
    name: str,
    ext: str,
    size: int,
    mtime_ns: int,
    sha256: str,
    mime: str | None,
) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "idx"."files"
              (root_id, path, name, ext, size, mtime_ns, sha256, mime, text_status, last_seen, deleted_at, error)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending', now(), NULL, NULL)
            ON CONFLICT (root_id, path) DO UPDATE SET
              name = EXCLUDED.name, ext = EXCLUDED.ext, size = EXCLUDED.size, mtime_ns = EXCLUDED.mtime_ns,
              sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime, text_status = 'pending',
              last_seen = now(), deleted_at = NULL, error = NULL
            RETURNING id
            """,
            (root_id, rel_path, name, ext, size, mtime_ns, sha256, mime),
        )
        row = cur.fetchone()
        assert row is not None
        file_id = int(row[0])
        cur.execute('DELETE FROM "idx"."chunks" WHERE file_id = %s', (file_id,))
        return file_id


def insert_chunks(conn: psycopg.Connection, file_id: int, pieces: Sequence[str], vectors: Sequence[Any]) -> None:
    if not pieces:
        return
    with conn.cursor() as cur:
        cur.executemany(
            'INSERT INTO "idx"."chunks" (file_id, idx, text, embedding) VALUES (%s, %s, %s, %s)',
            [(file_id, i, p, v) for i, (p, v) in enumerate(zip(pieces, vectors, strict=True))],
        )


def update_file_status(conn: psycopg.Connection, file_id: int, status: str, chars: int, error: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."files" SET text_status = %s, text_chars = %s, error = %s, indexed_at = now() WHERE id = %s',
            (status, chars, error, file_id),
        )


def chunks_missing_embeddings(conn: psycopg.Connection, root_id: int, rel_path: str) -> list[tuple[int, str]]:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT c.id, c.text FROM "idx"."chunks" c JOIN "idx"."files" f ON f.id = c.file_id '
            "WHERE f.root_id = %s AND f.path = %s AND c.embedding IS NULL ORDER BY c.idx",
            (root_id, rel_path),
        )
        return [(int(r[0]), r[1]) for r in cur.fetchall()]


def set_chunk_embeddings(conn: psycopg.Connection, pairs: Sequence[tuple[int, Any]]) -> None:
    if not pairs:
        return
    with conn.cursor() as cur:
        cur.executemany('UPDATE "idx"."chunks" SET embedding = %s WHERE id = %s', [(v, cid) for cid, v in pairs])


def mark_file_indexed(conn: psycopg.Connection, root_id: int, rel_path: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."files" SET text_status = \'indexed\', error = NULL WHERE root_id = %s AND path = %s',
            (root_id, rel_path),
        )


def mark_file_error(conn: psycopg.Connection, root_id: int, rel_path: str, error: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."files" SET text_status = \'error\', error = %s, indexed_at = now() WHERE root_id = %s AND path = %s',
            (error, root_id, rel_path),
        )


def mark_deleted(conn: psycopg.Connection, root_id: int, rel_path: str, is_dir: bool) -> list[int]:
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."files" SET deleted_at = now() WHERE root_id = %s AND deleted_at IS NULL '
            "AND (path = %s OR (%s AND starts_with(path, %s))) RETURNING id",
            (root_id, rel_path, is_dir, rel_path + "/"),
        )
        ids = [int(r[0]) for r in cur.fetchall()]
        if ids:
            cur.execute('DELETE FROM "idx"."chunks" WHERE file_id = ANY(%s)', (ids,))
    return ids


def rename_paths(conn: psycopg.Connection, root_id: int, old_rel: str, new_rel: str, is_dir: bool) -> int:
    with conn.transaction(), conn.cursor() as cur:
        if is_dir:
            old_prefix, new_prefix = old_rel + "/", new_rel + "/"
            cur.execute(
                'DELETE FROM "idx"."files" f USING "idx"."files" s '
                "WHERE f.root_id = %s AND s.root_id = %s AND starts_with(s.path, %s) AND s.deleted_at IS NULL "
                "AND f.path = %s || substr(s.path, %s)",
                (root_id, root_id, old_prefix, new_prefix, len(old_prefix) + 1),
            )
            cur.execute(
                'UPDATE "idx"."files" SET path = %s || substr(path, %s), last_seen = now() '
                "WHERE root_id = %s AND starts_with(path, %s) AND deleted_at IS NULL",
                (new_prefix, len(old_prefix) + 1, root_id, old_prefix),
            )
        else:
            cur.execute(
                'DELETE FROM "idx"."files" WHERE root_id = %s AND path = %s AND EXISTS '
                '(SELECT 1 FROM "idx"."files" WHERE root_id = %s AND path = %s AND deleted_at IS NULL)',
                (root_id, new_rel, root_id, old_rel),
            )
            cur.execute(
                'UPDATE "idx"."files" SET path = %s, name = %s, last_seen = now() '
                "WHERE root_id = %s AND path = %s AND deleted_at IS NULL",
                (new_rel, new_rel.rsplit("/", 1)[-1], root_id, old_rel),
            )
        return cur.rowcount


def insert_moves(conn: psycopg.Connection, root_id: int, src: str | None, dst: str | None, actor: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "idx"."moves" (root_id, src, dst, actor) VALUES (%s, %s, %s, %s)',
            (root_id, src, dst, actor),
        )


def record_event(conn: psycopg.Connection, root_id: int, event: Event) -> None:
    """Insert the durable row and NOTIFY listeners with the same payload."""
    payload = to_json(event)
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "idx"."events" (root_id, kind, path, target_path) VALUES (%s, %s, %s, %s)',
            (root_id, event["kind"], event["path"], event["target_path"]),
        )
        cur.execute("SELECT pg_notify('idx_events', %s)", (payload,))


def prune_events(conn: psycopg.Connection, older_than_days: int) -> int:
    cutoff = datetime.now().astimezone() - timedelta(days=older_than_days)
    with conn.cursor() as cur:
        cur.execute('DELETE FROM "idx"."events" WHERE at < %s', (cutoff,))
        return cur.rowcount


def start_scan(conn: psycopg.Connection, root_id: int) -> tuple[int, datetime]:
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "idx"."scans" (root_id, started_at) VALUES (%s, now()) RETURNING id, started_at',
            (root_id,),
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0]), row[1]


def finish_scan(conn: psycopg.Connection, scan_id: int, seen: int, changed: int, deleted: int, errors: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."scans" SET finished_at = now(), files_seen = %s, files_changed = %s, '
            "files_deleted = %s, errors = %s WHERE id = %s",
            (seen, changed, deleted, errors, scan_id),
        )


def sweep_vanished(conn: psycopg.Connection, root_id: int, seen_paths: Sequence[str], started_at: datetime) -> int:
    """Soft-delete rows for this root untouched since `started_at` that were not
    seen in the walk that just finished. Returns how many rows were deleted."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("CREATE TEMP TABLE seen_paths (path text PRIMARY KEY) ON COMMIT DROP")
        with cur.copy("COPY seen_paths (path) FROM STDIN") as cp:
            for p in seen_paths:
                cp.write_row((p,))
        cur.execute(
            """
            WITH gone AS (
              UPDATE "idx"."files" SET deleted_at = now()
              WHERE root_id = %s AND deleted_at IS NULL AND last_seen < %s
                AND path NOT IN (SELECT path FROM seen_paths)
              RETURNING id
            )
            DELETE FROM "idx"."chunks" WHERE file_id IN (SELECT id FROM gone)
            """,
            (root_id, started_at),
        )
        cur.execute('SELECT count(*) FROM "idx"."files" WHERE root_id = %s AND deleted_at >= %s', (root_id, started_at))
        row = cur.fetchone()
        deleted = int(row[0]) if row else 0
        cur.execute(
            'UPDATE "idx"."files" SET last_seen = now() WHERE root_id = %s AND path IN (SELECT path FROM seen_paths)',
            (root_id,),
        )
    return deleted


def read_settings(conn: psycopg.Connection) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute('SELECT key, value FROM "app"."settings"')
        return {r[0]: r[1] for r in cur.fetchall()}


def upsert_thumbnail(
    conn: psycopg.Connection,
    content_key: str,
    size: int,
    storage_path: str,
    width: int | None,
    height: int | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "app"."thumbnails" (content_key, size, storage_path, width, height, generated_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (content_key, size) DO UPDATE SET
              storage_path = EXCLUDED.storage_path, width = EXCLUDED.width, height = EXCLUDED.height,
              generated_at = now()
            """,
            (content_key, size, storage_path, width, height),
        )


def thumbnails_count(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute('SELECT count(*) FROM "app"."thumbnails"')
        row = cur.fetchone()
        return int(row[0]) if row else 0


def media_files(conn: psycopg.Connection, root_id: int) -> list[tuple[str, str, str, int]]:
    """`(path, ext, sha256, size)` for every live file in a root, for the
    rebuild-thumbnails pass to filter down to thumbnailable extensions and scope."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT path, ext, sha256, size FROM "idx"."files" WHERE root_id = %s AND deleted_at IS NULL',
            (root_id,),
        )
        return [(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]


def root_stats(conn: psycopg.Connection, root: str, root_id: int) -> RootStats:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT text_status, count(*) FROM "idx"."files" WHERE root_id = %s AND deleted_at IS NULL GROUP BY text_status',
            (root_id,),
        )
        counts = {r[0]: int(r[1]) for r in cur.fetchall()}
        cur.execute(
            "SELECT count(*), count(*) FILTER (WHERE c.embedding IS NOT NULL) "
            'FROM "idx"."chunks" c JOIN "idx"."files" f ON f.id = c.file_id '
            "WHERE f.root_id = %s AND f.deleted_at IS NULL",
            (root_id,),
        )
        row = cur.fetchone()
        chunks, embedded = (int(row[0]), int(row[1])) if row else (0, 0)
        cur.execute(
            "SELECT started_at, finished_at, files_seen, files_changed, files_deleted, errors "
            'FROM "idx"."scans" WHERE root_id = %s ORDER BY started_at DESC LIMIT 1',
            (root_id,),
        )
        scan_row = cur.fetchone()
        last_scan = (
            {
                "started_at": scan_row[0].isoformat(),
                "finished_at": scan_row[1].isoformat() if scan_row[1] else None,
                "files_seen": scan_row[2],
                "files_changed": scan_row[3],
                "files_deleted": scan_row[4],
                "errors": scan_row[5],
            }
            if scan_row
            else None
        )
    return RootStats(root=root, counts_by_status=counts, chunks=chunks, chunks_embedded=embedded, last_scan=last_scan)


def errors_sample(conn: psycopg.Connection, root_id: int, limit: int = 20) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT path, error FROM "idx"."files" WHERE root_id = %s AND text_status = \'error\' '
            "AND deleted_at IS NULL ORDER BY indexed_at DESC LIMIT %s",
            (root_id, limit),
        )
        return [{"path": r[0], "error": r[1]} for r in cur.fetchall()]


def mark_pending(conn: psycopg.Connection, root_id: int, exact_path: str | None, prefix: str | None) -> int:
    """Used by `POST /reindex`: mark rows pending so the next scan re-extracts them.
    `exact_path=None` marks every row in the root; otherwise the exact path and
    everything below it (when it is a directory) are marked."""
    with conn.cursor() as cur:
        if exact_path is None:
            cur.execute(
                'UPDATE "idx"."files" SET text_status = \'pending\' WHERE root_id = %s AND deleted_at IS NULL',
                (root_id,),
            )
        else:
            cur.execute(
                'UPDATE "idx"."files" SET text_status = \'pending\' WHERE root_id = %s AND deleted_at IS NULL '
                "AND (path = %s OR path LIKE %s)",
                (root_id, exact_path, prefix + "%" if prefix else exact_path),
            )
        return cur.rowcount
