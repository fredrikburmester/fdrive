"""Tests for `scripts/import-done-tsv.py`. The hyphen in the filename means it
cannot be imported with a normal `import` statement, so it is loaded via
`importlib` from its path, same as the CLI entrypoint would run it.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "import-done-tsv.py"


@pytest.fixture(scope="module")
def import_done_tsv() -> ModuleType:
    spec = importlib.util.spec_from_file_location("import_done_tsv_script", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclass() resolves annotations via sys.modules
    spec.loader.exec_module(module)
    return module


# -- parse_line -------------------------------------------------------------------


def test_parse_line_ocr_status(import_done_tsv: ModuleType) -> None:
    row = import_done_tsv.parse_line("12345_1699999999|folder/report.pdf\tocr")
    assert row == import_done_tsv.DoneRow(
        path="folder/report.pdf", size=12345, mtime_ns=1699999999_000000000, status="ocred", detail=None
    )


def test_parse_line_has_text_status(import_done_tsv: ModuleType) -> None:
    row = import_done_tsv.parse_line("100_200|a.pdf\thas_text")
    assert row is not None
    assert row.status == "has_text"


def test_parse_line_signed_and_encrypted(import_done_tsv: ModuleType) -> None:
    signed = import_done_tsv.parse_line("100_200|a.pdf\tsigned")
    encrypted = import_done_tsv.parse_line("100_200|b.pdf\tencrypted")
    assert signed is not None and signed.status == "signed"
    assert encrypted is not None and encrypted.status == "encrypted"


def test_parse_line_fail_rc_maps_to_failed_with_detail(import_done_tsv: ModuleType) -> None:
    row = import_done_tsv.parse_line("100_200|a.pdf\tfail_rc1")
    assert row is not None
    assert row.status == "failed"
    assert row.detail == "fail_rc1"


def test_parse_line_unrecognised_status_passes_through(import_done_tsv: ModuleType) -> None:
    row = import_done_tsv.parse_line("100_200|a.pdf\tsomething_else")
    assert row is not None
    assert row.status == "something_else"
    assert row.detail is None


def test_parse_line_blank_line_is_none(import_done_tsv: ModuleType) -> None:
    assert import_done_tsv.parse_line("") is None
    assert import_done_tsv.parse_line("   \n") is None


def test_parse_line_missing_tab_is_none(import_done_tsv: ModuleType) -> None:
    assert import_done_tsv.parse_line("100_200|a.pdf") is None


def test_parse_line_missing_pipe_is_none(import_done_tsv: ModuleType) -> None:
    assert import_done_tsv.parse_line("100_200a.pdf\tocr") is None


def test_parse_line_non_numeric_size_or_mtime_is_none(import_done_tsv: ModuleType) -> None:
    assert import_done_tsv.parse_line("abc_200|a.pdf\tocr") is None
    assert import_done_tsv.parse_line("100_abc|a.pdf\tocr") is None


def test_parse_line_missing_underscore_is_none(import_done_tsv: ModuleType) -> None:
    assert import_done_tsv.parse_line("100200|a.pdf\tocr") is None


def test_parse_lines_skips_bad_lines(import_done_tsv: ModuleType) -> None:
    lines = [
        "12345_1699999999|folder/report.pdf\tocr\n",
        "\n",
        "not a valid line\n",
        "100_200|scan.pdf\thas_text\n",
    ]
    rows = import_done_tsv.parse_lines(lines)
    assert len(rows) == 2
    assert rows[0].path == "folder/report.pdf"
    assert rows[1].path == "scan.pdf"


# -- main -----------------------------------------------------------------------


class FakeCursor:
    def __init__(self, results: list[object] | None = None) -> None:
        self.queries: list[tuple[str, tuple[object, ...]]] = []
        self._results = list(results or [])
        self._last_result: object = None

    def execute(self, query: str, params: tuple[object, ...] = ()) -> None:
        self.queries.append((query.strip(), params))
        self._last_result = self._results.pop(0) if self._results else None

    def fetchone(self) -> tuple[object, ...] | None:
        return self._last_result if isinstance(self._last_result, tuple) else None

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeConn:
    def __init__(self, cursor_obj: FakeCursor) -> None:
        self.cursor_obj = cursor_obj
        self.committed = False

    def cursor(self) -> FakeCursor:
        return self.cursor_obj

    def commit(self) -> None:
        self.committed = True

    def __enter__(self) -> FakeConn:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def test_main_end_to_end_against_fake_psycopg(
    import_done_tsv: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tsv_path = tmp_path / "done.tsv"
    tsv_path.write_text("12345_1699999999|folder/report.pdf\tocr\n100_200|scan.pdf\thas_text\n")

    cursor = FakeCursor(results=[(7,), None, None])  # roots upsert RETURNING id, then two ocr_log inserts
    conn = FakeConn(cursor)

    fake_psycopg = importlib.util.module_from_spec(importlib.util.spec_from_loader("psycopg", loader=None))
    fake_psycopg.connect = lambda dsn: conn  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)

    exit_code = import_done_tsv.main([str(tsv_path), "--root", "sftpgo", "--database-url", "postgres://x"])

    assert exit_code == 0
    assert conn.committed is True
    assert len(cursor.queries) == 3
    assert cursor.queries[0][1] == ("sftpgo",)
    assert "INSERT INTO" in cursor.queries[1][0]
    assert cursor.queries[1][1][0] == 7  # root_id
