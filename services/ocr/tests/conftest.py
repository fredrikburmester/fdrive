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
