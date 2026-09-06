"""All SQL. This service never creates or alters tables: schema ownership lives
in `packages/db/drizzle/*.sql`. It reads `app.settings` (shared with the
indexer) and `idx.roots` (upserting by name, same as the indexer), and owns
`idx.ocr_log` (the done-log) and `idx.ocr_runs` (nightly pass history).
"""

from __future__ import annotations

import time
from collections.abc import Callable

import psycopg

from .stats import RunSummary


def connect(dsn: str, retries: int = 30, sleep: Callable[[float], None] = time.sleep) -> psycopg.Connection:
    last: Exception | None = None
    for _ in range(retries):
        try:
            return psycopg.connect(dsn, autocommit=True)
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


def read_settings(conn: psycopg.Connection) -> dict[str, object]:
    with conn.cursor() as cur:
        cur.execute('SELECT key, value FROM "app"."settings"')
        return {r[0]: r[1] for r in cur.fetchall()}


def done_keys(conn: psycopg.Connection, root_id: int) -> set[tuple[str, int, int]]:
    """Every `(path, size, mtime_ns)` already recorded for this root: the
    done-log a pass consults so unchanged files are never reprocessed."""
    with conn.cursor() as cur:
        cur.execute('SELECT path, size, mtime_ns FROM "idx"."ocr_log" WHERE root_id = %s', (root_id,))
        return {(r[0], int(r[1]), int(r[2])) for r in cur.fetchall()}


def record_ocr_log(
    conn: psycopg.Connection,
    root_id: int,
    path: str,
    size: int,
    mtime_ns: int,
    status: str,
    detail: str | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "idx"."ocr_log" (root_id, path, size, mtime_ns, status, detail, at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (root_id, path, size, mtime_ns) DO UPDATE SET
              status = EXCLUDED.status, detail = EXCLUDED.detail, at = now()
            """,
            (root_id, path, size, mtime_ns, status, detail),
        )


def start_run(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute('INSERT INTO "idx"."ocr_runs" (started_at) VALUES (now()) RETURNING id')
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def finish_run(conn: psycopg.Connection, run_id: int, seen: int, ocred: int, skipped: int, failed: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "idx"."ocr_runs" SET finished_at = now(), seen = %s, ocred = %s, skipped = %s, failed = %s WHERE id = %s',
            (seen, ocred, skipped, failed, run_id),
        )


def last_run(conn: psycopg.Connection) -> RunSummary | None:
    with conn.cursor() as cur:
        cur.execute('SELECT started_at, finished_at, seen, ocred, skipped, failed FROM "idx"."ocr_runs" ORDER BY id DESC LIMIT 1')
        row = cur.fetchone()
        if row is None:
            return None
        return RunSummary(
            started_at=row[0].isoformat(),
            finished_at=row[1].isoformat() if row[1] else None,
            seen=int(row[2]),
            ocred=int(row[3]),
            skipped=int(row[4]),
            failed=int(row[5]),
        )
