"""Tests for `scripts/import-filesai.py`. The hyphen in the filename means it
cannot be imported with a normal `import` statement, so it is loaded via
`importlib` from its path, same as the CLI entrypoint would run it.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "import_filesai.py"


@pytest.fixture(scope="module")
def import_filesai() -> ModuleType:
    spec = importlib.util.spec_from_file_location("import_filesai_script", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclass() resolves annotations via sys.modules
    spec.loader.exec_module(module)
    return module


def test_map_file_row_full(import_filesai: ModuleType) -> None:
    raw = {
        "path": "docs/report.pdf",
        "name": "report.pdf",
        "ext": ".pdf",
        "size": 1234,
        "mtime_ns": 999,
        "sha256": "abc123",
        "mime": "application/pdf",
        "text_status": "indexed",
        "text_chars": 500,
        "error": None,
    }
    mapped = import_filesai.map_file_row(raw)
    assert mapped == import_filesai.FilesaiFile(
        path="docs/report.pdf",
        name="report.pdf",
        ext=".pdf",
        size=1234,
        mtime_ns=999,
        sha256="abc123",
        mime="application/pdf",
        text_status="indexed",
        text_chars=500,
        error=None,
    )


def test_map_file_row_defaults_missing_optional_fields(import_filesai: ModuleType) -> None:
    raw = {
        "path": "a.txt",
        "name": "a.txt",
        "ext": None,
        "size": 10,
        "mtime_ns": 1,
        "sha256": None,
        "mime": None,
        "text_status": None,
        "text_chars": None,
        "error": None,
    }
    mapped = import_filesai.map_file_row(raw)
    assert mapped.ext == ""
    assert mapped.text_status == "pending"
    assert mapped.text_chars == 0


def test_map_chunk_row(import_filesai: ModuleType) -> None:
    raw = {"idx": 2, "text": "hello world", "embedding": [0.1, 0.2]}
    chunk = import_filesai.map_chunk_row(raw, file_path="docs/report.pdf")
    assert chunk == import_filesai.FilesaiChunk(file_path="docs/report.pdf", idx=2, text="hello world", embedding=[0.1, 0.2])


def test_map_chunk_row_null_embedding_stays_null(import_filesai: ModuleType) -> None:
    raw = {"idx": 0, "text": "hi", "embedding": None}
    chunk = import_filesai.map_chunk_row(raw, file_path="a.txt")
    assert chunk.embedding is None


class FakeCursor:
    """Minimal stand-in for a psycopg cursor: records executed queries and
    replays canned results in order, enough to drive `import_files` without a
    real database."""

    def __init__(self, results: list[object] | None = None) -> None:
        self.queries: list[tuple[str, tuple[object, ...]]] = []
        self._results = list(results or [])
        self._last_result: object = None

    def execute(self, query: str, params: tuple[object, ...] = ()) -> None:
        self.queries.append((query.strip(), params))
        self._last_result = self._results.pop(0) if self._results else None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._last_result if isinstance(self._last_result, list) else []

    def fetchone(self) -> tuple[object, ...] | None:
        return self._last_result if isinstance(self._last_result, tuple) else None

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def test_import_files_copies_files_and_chunks(import_filesai: ModuleType) -> None:
    file_row = (1, "a.txt", "a.txt", ".txt", 10, 100, "sha1", "text/plain", "indexed", 5, None)
    chunk_row = (0, "hello", [0.1, 0.2])

    source = FakeCursor(
        results=[
            [file_row],  # SELECT ... FROM files
            [chunk_row],  # SELECT ... FROM chunks WHERE file_id = 1
        ]
    )
    target = FakeCursor(
        results=[
            (42,),  # RETURNING id from the files upsert
            None,  # DELETE FROM chunks
            None,  # INSERT INTO chunks
        ]
    )

    counts = import_filesai.import_files(source, target, root_id=7)

    assert counts == {"files": 1, "chunks": 1}
    insert_files_call = target.queries[0]
    assert "INSERT INTO" in insert_files_call[0]
    assert insert_files_call[1][0] == 7  # root_id
    assert insert_files_call[1][1] == "a.txt"  # path

    insert_chunk_call = target.queries[-1]
    assert "INSERT INTO" in insert_chunk_call[0]
    assert insert_chunk_call[1] == (42, 0, "hello", [0.1, 0.2])


def test_import_files_with_no_files_is_a_noop(import_filesai: ModuleType) -> None:
    source = FakeCursor(results=[[]])
    target = FakeCursor()
    counts = import_filesai.import_files(source, target, root_id=1)
    assert counts == {"files": 0, "chunks": 0}


def test_main_runs_end_to_end_against_fake_psycopg(import_filesai: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    file_row = (1, "a.txt", "a.txt", ".txt", 10, 100, "sha1", "text/plain", "indexed", 5, None)

    class FakeConn:
        def __init__(self) -> None:
            self.cursor_obj = FakeCursor(
                results=[
                    (9,),  # roots upsert RETURNING id
                    [file_row],  # SELECT files
                    [],  # SELECT chunks for file 1
                    (42,),  # files upsert RETURNING id
                    None,  # DELETE chunks
                ]
            )

        def cursor(self) -> FakeCursor:
            return self.cursor_obj

        def commit(self) -> None:
            self.committed = True

        def __enter__(self) -> FakeConn:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

    conns: list[FakeConn] = []

    def fake_connect(dsn: str) -> FakeConn:
        conn = FakeConn()
        conns.append(conn)
        return conn

    fake_psycopg = importlib.util.module_from_spec(importlib.util.spec_from_loader("psycopg", loader=None))
    fake_psycopg.connect = fake_connect  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)

    exit_code = import_filesai.main(["--source", "src-dsn", "--target", "tgt-dsn", "--root", "sftpgo"])
    assert exit_code == 0
    assert len(conns) == 2
    assert conns[1].committed is True  # target connection committed
