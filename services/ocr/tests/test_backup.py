from __future__ import annotations

import hashlib
import json
from pathlib import Path

import psycopg
import pytest

from fdrive_ocr import db, runner


def test_original_mapping_preserves_source_facts_and_checksum(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pre-OCR original")
    stat = source.stat()
    rewritten = tmp_path / "processed.pdf"
    rewritten.write_bytes(b"searchable PDF")
    state = tmp_path / "state"
    runner.apply_rewrite(str(source), str(rewritten), str(state), "documents", "folder/source.pdf",
                         stat.st_size, stat.st_mtime_ns, True)
    mapping = json.loads(next((state / "original-mappings").glob("*.json")).read_text())
    assert mapping["path"] == "folder/source.pdf"
    assert mapping["root"] == "documents"
    assert mapping["mtime_ns"] == str(stat.st_mtime_ns)
    assert mapping["sha256"] == hashlib.sha256(b"pre-OCR original").hexdigest()
    assert (state / "originals" / mapping["original"]).read_bytes() == b"pre-OCR original"
    assert source.read_bytes() == b"searchable PDF"


def test_checkpoint_releases_after_failed_rewrite(db_conn: psycopg.Connection, postgres_dsn: str) -> None:
    with pytest.raises(RuntimeError, match="rewrite failed"), db.backup_checkpoint(db_conn):
        raise RuntimeError("rewrite failed")
    with psycopg.connect(postgres_dsn, autocommit=True) as contender, contender.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (736591204,))
        assert cur.fetchone() == (True,)
        cur.execute("SELECT pg_advisory_unlock(%s)", (736591204,))


def test_directory_flush_failure_keeps_source_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import os
    import stat as stat_module

    source = tmp_path / "source.pdf"
    source.write_bytes(b"original")
    before = source.stat()
    rewritten = tmp_path / "rewritten.pdf"
    rewritten.write_bytes(b"processed")
    real_fsync = os.fsync

    def fail_directory_flush(fd: int) -> None:
        if stat_module.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("directory flush failed")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", fail_directory_flush)
    with pytest.raises(OSError, match="directory flush failed"):
        runner.apply_rewrite(str(source), str(rewritten), str(tmp_path / "state"), "documents", "source.pdf",
                             before.st_size, before.st_mtime_ns, True)
    assert source.read_bytes() == b"original"
