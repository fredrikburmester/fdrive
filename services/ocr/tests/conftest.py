"""Shared fixtures for the I/O tests: a real Postgres (via testcontainers) with
the repo's own Drizzle migrations applied, matching what this service runs
against in production, and a fake `ocrmypdf` executable placed first on PATH so
no test ever needs a real scanned PDF or the real (slow) tool.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from testcontainers.postgres import PostgresContainer

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def _migrations_dir() -> Path:
    """Normally three levels above this file (the repo root's
    `packages/db/drizzle`). `FDRIVE_DB_MIGRATIONS_DIR` overrides this for
    `scripts/test-in-docker.sh`, where the container only mounts a subset of
    the repo and the path depth does not match the host checkout."""
    override = os.environ.get("FDRIVE_DB_MIGRATIONS_DIR")
    if override:
        return Path(override)
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "packages" / "db" / "drizzle"


MIGRATIONS_DIR = _migrations_dir()


def _migration_statements() -> list[str]:
    sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        pytest.skip(f"no migrations found under {MIGRATIONS_DIR}")
    statements: list[str] = []
    for path in sql_files:
        raw = path.read_text()
        for chunk in re.split(r"--> statement-breakpoint", raw):
            stripped = chunk.strip()
            if stripped:
                statements.append(stripped)
    return statements


@pytest.fixture(scope="session")
def postgres_dsn() -> Iterator[str]:
    with PostgresContainer("pgvector/pgvector:pg17", driver=None) as pg:
        dsn = pg.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        conn = psycopg.connect(dsn, autocommit=True)
        try:
            with conn.cursor() as cur:
                for statement in _migration_statements():
                    cur.execute(statement)
        finally:
            conn.close()
        yield dsn


@pytest.fixture
def db_conn(postgres_dsn: str) -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(postgres_dsn, autocommit=True)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _clean_tables(postgres_dsn: str) -> Iterator[None]:
    """Truncate the mutable tables before each test so tests are independent."""
    yield
    conn = psycopg.connect(postgres_dsn, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                'TRUNCATE "idx"."ocr_log", "idx"."ocr_runs", "idx"."events", "idx"."moves", "idx"."scans", '
                '"idx"."chunks", "idx"."files", "idx"."roots", "app"."thumbnails", "app"."settings" '
                "RESTART IDENTITY CASCADE"
            )
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _fake_ocrmypdf_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Puts `tests/fixtures` (the fake `ocrmypdf`) first on `PATH` for every
    test, matching how `scripts/test-in-docker.sh` and CI run against it."""
    monkeypatch.setenv("PATH", f"{FIXTURES_DIR}{os.pathsep}{os.environ.get('PATH', '')}")


class Journal:
    """What the indexer would receive from this service: `idx.changes` rows and
    `NOTIFY idx_changes` payloads, read through a connection that listens the
    way the indexer's journal thread does."""

    def __init__(self, dsn: str, listener: psycopg.Connection) -> None:
        self._dsn = dsn
        self._listener = listener

    def rows(self) -> list[tuple[object, ...]]:
        # Not on the listener: a query there could consume a pending notification.
        with psycopg.connect(self._dsn, autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT root_id, path, target_path, source, sha256, size, mtime_ns, inode, ctime_ns "
                'FROM "idx"."changes" ORDER BY id'
            )
            return list(cur.fetchall())

    def notifications(self) -> list[str]:
        """Payloads delivered since the last call. Postgres sends them on commit,
        before the writer's call returns, so a short wait collects them all."""
        return [notify.payload for notify in self._listener.notifies(timeout=0.5) if notify.channel == "idx_changes"]


@pytest.fixture
def journal(postgres_dsn: str) -> Iterator[Journal]:
    listener = psycopg.connect(postgres_dsn, autocommit=True)
    try:
        listener.execute("LISTEN idx_changes")
        yield Journal(postgres_dsn, listener)
    finally:
        listener.close()


@pytest.fixture
def failing_journal(postgres_dsn: str) -> Iterator[None]:
    """Makes every `idx.changes` insert fail inside Postgres, as a broken or
    unreachable journal would, until the test ends."""
    conn = psycopg.connect(postgres_dsn, autocommit=True)
    try:
        conn.execute(
            "CREATE FUNCTION public.fail_journal() RETURNS trigger LANGUAGE plpgsql AS "
            "$$ BEGIN RAISE EXCEPTION 'idx.changes is unavailable'; END $$"
        )
        conn.execute(
            'CREATE TRIGGER fail_journal BEFORE INSERT ON "idx"."changes" '
            "FOR EACH ROW EXECUTE FUNCTION public.fail_journal()"
        )
        yield
    finally:
        conn.execute('DROP TRIGGER IF EXISTS fail_journal ON "idx"."changes"')
        conn.execute("DROP FUNCTION IF EXISTS public.fail_journal()")
        conn.close()
