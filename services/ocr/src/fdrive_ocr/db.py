"""All SQL. This service never creates or alters tables: schema ownership lives
in `packages/db/drizzle/*.sql`. It reads `app.settings` (shared with the
indexer), `idx.roots` (upserting by name, same as the indexer) and the PDFs the
indexer recorded in `idx.files`, and owns `idx.ocr_log` (the done-log) and
`idx.ocr_runs` (nightly pass history). It journals the files it rewrites in
`idx.changes`, as the API does its own.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass

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


@dataclass(frozen=True)
class IndexedPdf:
    """A PDF as the indexer last read it: root-relative `path`, and the `size`,
    `mtime_ns` and content digest it had then."""

    path: str
    size: int
    mtime_ns: int
    sha256: str


def pdf_candidates(conn: psycopg.Connection, root_id: int, reserved: Sequence[str]) -> list[IndexedPdf]:
    """The PDFs a pass considers for this root, by path: every live PDF the index
    holds outside the folders named in `reserved` (any segment, any case) whose
    content this service has not decided on yet, wherever it decided on it."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT f.path, f.size, f.mtime_ns, f.sha256 FROM "idx"."files" f
            WHERE f.root_id = %s AND f.ext = '.pdf' AND f.deleted_at IS NULL AND f.sha256 IS NOT NULL
              AND NOT (string_to_array(lower(f.path), '/') && %s::text[])
              AND NOT EXISTS (SELECT 1 FROM "idx"."ocr_log" l WHERE l.sha256 = f.sha256)
            ORDER BY f.path
            """,
            (root_id, list(reserved)),
        )
        return [IndexedPdf(str(r[0]), int(r[1]), int(r[2]), str(r[3])) for r in cur.fetchall()]


def is_done(conn: psycopg.Connection, sha256: str) -> bool:
    """Whether this content was decided on since a pass listed it: by a copy of it
    earlier in the same pass, or by a restore."""
    with conn.cursor() as cur:
        cur.execute('SELECT 1 FROM "idx"."ocr_log" WHERE sha256 = %s LIMIT 1', (sha256,))
        return cur.fetchone() is not None


@contextmanager
def ocr_file_lock(conn: psycopg.Connection, root_id: int, path: str) -> Iterator[None]:
    """Serialize OCR/restore commits for one source across service connections.

    Take this before the backup gate. The two-int key space is separate from
    the backup gate's bigint keys; a hash collision only serializes extra files.
    fdrive's API and other writers do not take this lock, so callers also check
    right before they write that the file is still the version they read.
    """
    key = f"{root_id}:{path}"
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s, hashtext(%s))", (736591207, key))
    try:
        yield
    finally:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s, hashtext(%s))", (736591207, key))


def record_ocr_log(
    conn: psycopg.Connection,
    root_id: int,
    path: str,
    size: int,
    mtime_ns: int,
    sha256: str,
    status: str,
    detail: str | None,
) -> None:
    """Records a decision on the content `sha256`, found at `path` with `size` and
    `mtime_ns`. The digest is what marks the content done; the path and stamp are
    what kept originals compare a live file with."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "idx"."ocr_log" (root_id, path, size, mtime_ns, sha256, status, detail, at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (root_id, path, size, mtime_ns) DO UPDATE SET
              sha256 = EXCLUDED.sha256, status = EXCLUDED.status, detail = EXCLUDED.detail, at = now()
            """,
            (root_id, path, size, mtime_ns, sha256, status, detail),
        )


#: The channel a write to the change journal wakes; the payload is the root's name.
CHANGES_CHANNEL = "idx_changes"

#: Taken before inserting into the journal and held until commit, by every writer in every
#: language, so positions commit in order (docs/plans/CHANGE-JOURNAL.md).
JOURNAL_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('idx.changes', 0))"


def journal_change(conn: psycopg.Connection, root_id: int, root: str, path: str, log: Callable[[str], None]) -> None:
    """Tells the indexer, and every other reader of the change journal, that this
    service rewrote `path` (root-relative, as `idx.files.path`) with an OCR
    result or a restored original: an `idx.changes` row with source `ocr`, in
    one transaction that takes the journal's lock first and sends
    `NOTIFY idx_changes` with the root's name, as the API's
    `createChangeJournal` writes them. The row has no content hint, since the
    bytes are new and the indexer has to read them.

    A row only makes the indexer look sooner. A failure is logged and never
    raised: its watcher and periodic scan still find the change.
    """
    try:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(JOURNAL_LOCK)
            cur.execute(
                """INSERT INTO "idx"."changes" (root_id, path, source) VALUES (%s, %s, 'ocr')""", (root_id, path)
            )
            cur.execute("SELECT pg_notify(%s, %s)", (CHANGES_CHANNEL, root))
    except psycopg.Error as error:
        log(f"[{root}] could not tell the indexer about {path}: {error}")


def ocred_keys_for_paths(
    conn: psycopg.Connection, root_id: int, paths: list[str]
) -> dict[str, frozenset[tuple[int, int]]]:
    """The `(size, mtime_ns)` pairs recorded as `ocred` for each of `paths`.

    Lets the originals listing tell "this is still the OCR output" apart from
    "someone edited this afterwards" without re-reading any file bytes.
    """
    if not paths:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            'SELECT path, size, mtime_ns FROM "idx"."ocr_log" WHERE root_id = %s AND path = ANY(%s) AND status = %s',
            (root_id, paths, "ocred"),
        )
        keys: dict[str, set[tuple[int, int]]] = {}
        for row in cur.fetchall():
            keys.setdefault(row[0], set()).add((int(row[1]), int(row[2])))
    return {path: frozenset(pairs) for path, pairs in keys.items()}


def legacy_candidates(conn: psycopg.Connection, mtime_ns: int, basename: str, limit: int) -> list[tuple[str, str, int]]:
    """Done-log rows that could be the source of a kept original whose sidecar
    predates this format: same mtime, same filename. The caller reverse-hashes
    each one against the kept file's name and only accepts a unique match, the
    same rule `packages/backup/src/ocr-mappings.ts` applies to archived bytes.

    Returns `limit + 1` rows at most so the caller can tell a truncated
    candidate set (never resolved, to avoid a wrong match) from a complete one.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT r.name, l.path, l.mtime_ns FROM \"idx\".\"ocr_log\" l "
            'JOIN "idx"."roots" r ON r.id = l.root_id '
            "WHERE l.mtime_ns = %s AND regexp_replace(l.path, '^.*/', '') = %s LIMIT %s",
            (mtime_ns, basename, limit + 1),
        )
        return [(str(row[0]), str(row[1]), int(row[2])) for row in cur.fetchall()]


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


@contextmanager
def backup_checkpoint(conn: psycopg.Connection) -> Iterator[None]:
    """Match the API's blob writer gate through rewrite and its durable receipt."""
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock_shared(%s)", (736591204,))
    try:
        yield
    finally:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock_shared(%s)", (736591204,))
