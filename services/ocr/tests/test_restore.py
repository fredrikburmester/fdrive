"""I/O tests for kept-original administration, against a real Postgres and a
real filesystem. The central guarantee is the round trip: a file OCR'd by a
pass can be restored, and a later pass leaves the restored file alone.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import psycopg
import pytest

from fdrive_ocr import db, restore, runner
from fdrive_ocr.originals import Mapping, mapping_document
from fdrive_ocr.runner import RootTarget
from fdrive_ocr.settings import Settings

SETTINGS = Settings(
    hour=3, langs="eng", exclude_globs=(), max_mb=200, keep_originals=True, originals_retention_days=0
)
ORIGINAL_BODY = b"OK\nthe original scan\n"
OCRED_BODY = b"OK-OCRED-OUTPUT\n"


@pytest.fixture
def root_dir(tmp_path: Path) -> Path:
    path = tmp_path / "root"
    (path / "docs").mkdir(parents=True)
    return path


@pytest.fixture
def state_dir(tmp_path: Path) -> str:
    return str(tmp_path / "state")


@pytest.fixture
def target(db_conn: psycopg.Connection, root_dir: Path) -> RootTarget:
    return RootTarget(name="sftpgo", root_id=db.upsert_root(db_conn, "sftpgo"), abs_path=str(root_dir))


def _run_pass(conn: psycopg.Connection, target: RootTarget, state_dir: str, settings: Settings = SETTINGS) -> runner.RunTotals:
    return runner.run_pass(conn, [target], settings, state_dir, 30, 1, lambda _msg: None)


def _sole_original(state_dir: str) -> restore.OriginalEntry:
    entries = restore.scan_originals(state_dir)
    assert len(entries) == 1
    return entries[0]


def _ocr_log(conn: psycopg.Connection) -> list[tuple[str, int, int, str]]:
    with conn.cursor() as cur:
        cur.execute('SELECT path, size, mtime_ns, status FROM "idx"."ocr_log" ORDER BY id')
        return [(str(r[0]), int(r[1]), int(r[2]), str(r[3])) for r in cur.fetchall()]


# -- the round trip ------------------------------------------------------------------


def test_restores_an_ocred_file_and_the_next_pass_leaves_it_alone(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    scan = root_dir / "docs" / "scan.pdf"
    scan.write_bytes(ORIGINAL_BODY)
    os.chmod(scan, 0o640)
    before = scan.stat()

    assert _run_pass(db_conn, target, state_dir).ocred == 1
    assert scan.read_bytes() == OCRED_BODY

    index = restore.OriginalsIndex()
    listed, total = restore.list_originals(db_conn, state_dir, [target], index)
    assert total == 1
    assert (listed[0].root, listed[0].path, listed[0].state) == ("sftpgo", "docs/scan.pdf", "ocred")

    outcome = restore.restore_original(
        db_conn, state_dir, [target], index, listed[0].id, False, False, lambda _msg: None
    )
    assert outcome == restore.RestoreOutcome(True, None, "ocred", "sftpgo", "docs/scan.pdf")
    after = scan.stat()
    assert scan.read_bytes() == ORIGINAL_BODY
    assert after.st_mtime_ns == before.st_mtime_ns
    assert after.st_mode == before.st_mode

    assert ("docs/scan.pdf", before.st_size, before.st_mtime_ns, "restored") in _ocr_log(db_conn)

    # Without the `restored` done-log row the next pass would OCR it straight back.
    assert _run_pass(db_conn, target, state_dir).ocred == 0
    assert scan.read_bytes() == ORIGINAL_BODY

    relisted, _total = restore.list_originals(db_conn, state_dir, [target], index)
    assert relisted[0].state == "restored"


def test_a_restored_original_stays_kept_and_can_be_restored_again(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    scan = root_dir / "docs" / "scan.pdf"
    scan.write_bytes(ORIGINAL_BODY)
    _run_pass(db_conn, target, state_dir)
    index = restore.OriginalsIndex()
    original_id = _sole_original(state_dir).id

    assert restore.restore_original(db_conn, state_dir, [target], index, original_id, False, False, lambda _m: None).ok
    scan.write_bytes(b"OK\nlocal edit\n")
    assert restore.restore_original(db_conn, state_dir, [target], index, original_id, False, True, lambda _m: None).ok
    assert scan.read_bytes() == ORIGINAL_BODY
    assert len(restore.scan_originals(state_dir)) == 1


# -- refusals -------------------------------------------------------------------------


def _keep(state_dir: str, root_dir: Path, rel_path: str, body: bytes = ORIGINAL_BODY) -> str:
    """Runs a rewrite by hand so a test can set up a kept original without a pass."""
    source = root_dir / rel_path
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(body)
    info = source.stat()
    rewritten = root_dir.parent / "rewritten.pdf"
    rewritten.write_bytes(OCRED_BODY)
    runner.apply_rewrite(str(source), str(rewritten), state_dir, "sftpgo", rel_path, info.st_size, info.st_mtime_ns, True)
    return os.path.basename(runner.originals_dest(state_dir, "sftpgo", rel_path, info.st_size, info.st_mtime_ns))


def test_refuses_to_overwrite_a_file_changed_since_ocr_unless_asked(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    edited = b"OK\nsomething entirely different\n"
    (root_dir / "docs" / "scan.pdf").write_bytes(edited)
    index = restore.OriginalsIndex()

    refused = restore.restore_original(db_conn, state_dir, [target], index, original_id, False, False, lambda _m: None)
    assert (refused.ok, refused.reason, refused.state) == (False, "target_changed", "changed")
    assert (root_dir / "docs" / "scan.pdf").read_bytes() == edited

    allowed = restore.restore_original(db_conn, state_dir, [target], index, original_id, False, True, lambda _m: None)
    assert allowed.ok is True
    assert (root_dir / "docs" / "scan.pdf").read_bytes() == ORIGINAL_BODY


def test_refuses_to_recreate_a_deleted_file_unless_asked(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    (root_dir / "docs" / "scan.pdf").unlink()
    index = restore.OriginalsIndex()

    refused = restore.restore_original(db_conn, state_dir, [target], index, original_id, False, False, lambda _m: None)
    assert (refused.ok, refused.reason, refused.state) == (False, "target_missing", "missing")
    assert not (root_dir / "docs" / "scan.pdf").exists()

    allowed = restore.restore_original(db_conn, state_dir, [target], index, original_id, True, False, lambda _m: None)
    assert allowed.ok is True
    assert (root_dir / "docs" / "scan.pdf").read_bytes() == ORIGINAL_BODY


def test_refuses_to_recreate_a_file_whose_directory_is_gone(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "gone/scan.pdf")
    (root_dir / "gone" / "scan.pdf").unlink()
    (root_dir / "gone").rmdir()

    outcome = restore.restore_original(
        db_conn, state_dir, [target], restore.OriginalsIndex(), original_id, True, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason) == (False, "target_parent_missing")
    assert not (root_dir / "gone").exists()


def test_refuses_kept_bytes_that_no_longer_match_their_checksum(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    Path(restore.originals_dir(state_dir), original_id).write_bytes(b"OK\nrotted\n")

    outcome = restore.restore_original(
        db_conn, state_dir, [target], restore.OriginalsIndex(), original_id, False, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason) == (False, "corrupt")
    assert (root_dir / "docs" / "scan.pdf").read_bytes() == OCRED_BODY
    assert not [name for name in os.listdir(root_dir / "docs") if name.startswith("._fdrive-restore-")]


@pytest.mark.parametrize("original_id", ["../../etc/passwd", "sub/scan.pdf", "", ".original-half-written"])
def test_refuses_an_identifier_that_is_not_a_plain_filename(
    db_conn: psycopg.Connection, state_dir: str, target: RootTarget, original_id: str
) -> None:
    outcome = restore.restore_original(
        db_conn, state_dir, [target], restore.OriginalsIndex(), original_id, True, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason) == (False, "not_found")


def test_refuses_a_sidecar_whose_path_escapes_its_root(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    sidecar = Path(restore.mappings_dir(state_dir), f"{original_id}.json")
    document = json.loads(sidecar.read_text())
    sidecar.write_text(json.dumps({**document, "path": "docs/../../outside.pdf"}))

    outcome = restore.restore_original(
        db_conn, state_dir, [target], restore.OriginalsIndex(), original_id, True, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason) == (False, "invalid_path")
    assert not (root_dir.parent / "outside.pdf").exists()


def test_refuses_an_original_kept_for_a_root_this_service_no_longer_has(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    outcome = restore.restore_original(
        db_conn, state_dir, [], restore.OriginalsIndex(), original_id, True, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason, outcome.root) == (False, "unknown_root", "sftpgo")


def test_refuses_a_kept_path_that_is_not_a_regular_file(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    os.makedirs(restore.originals_dir(state_dir), exist_ok=True)
    os.symlink(root_dir / "docs", Path(restore.originals_dir(state_dir), "link.pdf"))

    outcome = restore.restore_original(
        db_conn, state_dir, [target], restore.OriginalsIndex(), "link.pdf", True, True, lambda _m: None
    )
    assert (outcome.ok, outcome.reason) == (False, "not_found")
    assert restore.open_original(state_dir, "link.pdf") is None


def test_resolve_target_path_keeps_a_relative_path_inside_its_root(tmp_path: Path) -> None:
    root = str(tmp_path / "root")
    os.makedirs(root)
    assert restore.resolve_target_path(root, "docs/../a.pdf") == os.path.join(root, "a.pdf")
    assert restore.resolve_target_path(root, "../a.pdf") is None
    assert restore.resolve_target_path(root, "/etc/passwd") is None
    assert restore.resolve_target_path(root, "") is None
    assert restore.resolve_target_path(root, "a\0.pdf") is None


def test_resolve_target_path_refuses_a_parent_symlinked_out_of_the_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "docs").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside)
    assert restore.resolve_target_path(str(root), "escape/a.pdf") is None
    assert restore.resolve_target_path(str(root), "docs/a.pdf") is not None


# -- legacy originals ------------------------------------------------------------------


def test_resolves_a_legacy_original_from_the_done_log_and_backfills_its_sidecar(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    kept = Path(restore.originals_dir(state_dir), original_id)
    source_mtime_ns = kept.stat().st_mtime_ns
    Path(restore.mappings_dir(state_dir), f"{original_id}.json").unlink()
    db.record_ocr_log(db_conn, target.root_id, "docs/scan.pdf", len(OCRED_BODY), source_mtime_ns, "ocred", None)

    index = restore.OriginalsIndex()
    listed, _total = restore.list_originals(db_conn, state_dir, [target], index)
    assert (listed[0].root, listed[0].path, listed[0].legacy) == ("sftpgo", "docs/scan.pdf", True)

    backfilled = json.loads(Path(restore.mappings_dir(state_dir), f"{original_id}.json").read_text())
    assert backfilled["legacy"] is True
    assert backfilled["path"] == "docs/scan.pdf"

    assert restore.restore_original(db_conn, state_dir, [target], index, original_id, False, True, lambda _m: None).ok
    assert (root_dir / "docs" / "scan.pdf").read_bytes() == ORIGINAL_BODY


def test_leaves_an_unresolvable_legacy_original_alone(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    Path(restore.mappings_dir(state_dir), f"{original_id}.json").unlink()

    index = restore.OriginalsIndex()
    listed, _total = restore.list_originals(db_conn, state_dir, [target], index)
    assert (listed[0].root, listed[0].path, listed[0].state, listed[0].legacy) == (None, None, None, True)

    outcome = restore.restore_original(db_conn, state_dir, [target], index, original_id, True, True, lambda _m: None)
    assert (outcome.ok, outcome.reason) == (False, "unresolved")
    # The bytes survive an unresolved lookup, so they can still be downloaded.
    assert restore.open_original(state_dir, original_id) is not None


def test_does_not_resolve_a_legacy_original_whose_name_has_no_hash_prefix(
    db_conn: psycopg.Connection, state_dir: str
) -> None:
    os.makedirs(restore.originals_dir(state_dir), exist_ok=True)
    Path(restore.originals_dir(state_dir), "scan.pdf").write_bytes(ORIGINAL_BODY)
    entry = _sole_original(state_dir)
    assert restore.resolve_legacy(db_conn, state_dir, entry) is None


def test_does_not_resolve_a_legacy_original_whose_bytes_are_gone(
    db_conn: psycopg.Connection, state_dir: str
) -> None:
    entry = restore.OriginalEntry(id="0123456789abcdef_scan.pdf", size=1, kept_at=0.0, mapping=None)
    assert restore.resolve_legacy(db_conn, state_dir, entry) is None


def test_does_not_guess_between_two_matching_legacy_candidates(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    Path(restore.mappings_dir(state_dir), f"{original_id}.json").unlink()
    kept_mtime_ns = Path(restore.originals_dir(state_dir), original_id).stat().st_mtime_ns
    db.record_ocr_log(db_conn, target.root_id, "docs/scan.pdf", 1, kept_mtime_ns, "ocred", None)
    monkeypatch.setattr(restore, "LEGACY_CANDIDATE_LIMIT", 0)

    assert restore.resolve_legacy(db_conn, state_dir, _sole_original(state_dir)) is None


# -- listing ---------------------------------------------------------------------------


def test_lists_newest_first_and_pages_without_stating_the_whole_archive(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    for index_number in range(3):
        _keep(state_dir, root_dir, f"docs/scan{index_number}.pdf", ORIGINAL_BODY + bytes([index_number]))
        time.sleep(0.01)
    index = restore.OriginalsIndex()

    page, total = restore.list_originals(db_conn, state_dir, [target], index, limit=2)
    assert total == 3
    assert [item.path for item in page] == ["docs/scan2.pdf", "docs/scan1.pdf"]

    rest, total = restore.list_originals(db_conn, state_dir, [target], index, offset=2, limit=2)
    assert (total, [item.path for item in rest]) == (3, ["docs/scan0.pdf"])


def test_search_narrows_the_listing_to_matching_source_paths(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    _keep(state_dir, root_dir, "docs/invoice.pdf")
    _keep(state_dir, root_dir, "photos/holiday.pdf", ORIGINAL_BODY + b"x")
    index = restore.OriginalsIndex()

    page, total = restore.list_originals(db_conn, state_dir, [target], index, query="INVOICE")
    assert (total, [item.path for item in page]) == (1, ["docs/invoice.pdf"])


def test_an_empty_state_directory_lists_nothing(
    db_conn: psycopg.Connection, state_dir: str, target: RootTarget
) -> None:
    assert restore.list_originals(db_conn, state_dir, [target], restore.OriginalsIndex()) == ([], 0)
    assert restore.originals_stats(state_dir) == (0, 0)


def test_skips_half_written_keeps_and_subdirectories(state_dir: str) -> None:
    os.makedirs(restore.originals_dir(state_dir))
    Path(restore.originals_dir(state_dir), "abc_scan.pdf").write_bytes(b"1234")
    Path(restore.originals_dir(state_dir), ".original-pending").write_bytes(b"12")
    os.mkdir(Path(restore.originals_dir(state_dir), "nested"))

    assert [entry.id for entry in restore.scan_originals(state_dir)] == ["abc_scan.pdf"]
    assert restore.originals_stats(state_dir) == (1, 4)


def test_reports_no_state_for_an_original_whose_root_is_not_configured(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str
) -> None:
    _keep(state_dir, root_dir, "docs/scan.pdf")
    listed, _total = restore.list_originals(db_conn, state_dir, [], restore.OriginalsIndex())
    assert (listed[0].root, listed[0].path, listed[0].state) == ("sftpgo", "docs/scan.pdf", None)


def test_an_unreadable_sidecar_reads_as_unresolved(state_dir: str, root_dir: Path) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    Path(restore.mappings_dir(state_dir), f"{original_id}.json").write_text("{not json")
    mapping, written_at = restore.read_mapping(state_dir, original_id)
    assert (mapping, written_at) == (None, None)


# -- kept-at, caching, delete and prune --------------------------------------------------


def test_kept_at_ignores_the_source_mtime_the_copy_inherited(
    root_dir: Path, state_dir: str
) -> None:
    source = root_dir / "docs" / "old.pdf"
    source.write_bytes(ORIGINAL_BODY)
    ancient = time.time() - 86400 * 365 * 5
    os.utime(source, (ancient, ancient))
    rewritten = root_dir.parent / "rewritten.pdf"
    rewritten.write_bytes(OCRED_BODY)
    info = source.stat()
    runner.apply_rewrite(
        str(source), str(rewritten), state_dir, "sftpgo", "docs/old.pdf", info.st_size, info.st_mtime_ns, True
    )

    entry = _sole_original(state_dir)
    assert Path(restore.originals_dir(state_dir), entry.id).stat().st_mtime == pytest.approx(ancient, abs=1)
    assert entry.kept_at == pytest.approx(time.time(), abs=60)


def test_kept_at_falls_back_to_the_sidecar_then_to_the_kept_file(
    root_dir: Path, state_dir: str
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    sidecar = Path(restore.mappings_dir(state_dir), f"{original_id}.json")
    document = json.loads(sidecar.read_text())
    del document["kept_at_ns"]
    sidecar.write_text(json.dumps(document))
    stamp = time.time() - 3600
    os.utime(sidecar, (stamp, stamp))
    assert _sole_original(state_dir).kept_at == pytest.approx(stamp, abs=1)

    sidecar.unlink()
    kept_ctime = Path(restore.originals_dir(state_dir), original_id).stat().st_ctime
    assert _sole_original(state_dir).kept_at == pytest.approx(kept_ctime, abs=1)


def test_the_index_rescans_only_when_the_state_directory_changes(
    root_dir: Path, state_dir: str
) -> None:
    _keep(state_dir, root_dir, "docs/scan.pdf")
    index = restore.OriginalsIndex()
    assert index.stats(state_dir) == (1, len(ORIGINAL_BODY))

    Path(restore.originals_dir(state_dir), "sneaked.pdf").write_bytes(b"1234")
    assert index.stats(state_dir) == (2, len(ORIGINAL_BODY) + 4)

    index.invalidate()
    assert index.stats(state_dir) == (2, len(ORIGINAL_BODY) + 4)


def test_deleting_an_original_removes_its_bytes_and_its_sidecar(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    index = restore.OriginalsIndex()

    assert restore.delete_original(db_conn, state_dir, index, original_id) is True
    assert not Path(restore.originals_dir(state_dir), original_id).exists()
    assert not Path(restore.mappings_dir(state_dir), f"{original_id}.json").exists()
    assert index.stats(state_dir) == (0, 0)

    assert restore.delete_original(db_conn, state_dir, index, original_id) is False
    assert restore.delete_original(db_conn, state_dir, index, "../escape") is False


def test_prune_removes_only_originals_past_the_retention_window(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str
) -> None:
    old_id = _keep(state_dir, root_dir, "docs/old.pdf")
    new_id = _keep(state_dir, root_dir, "docs/new.pdf", ORIGINAL_BODY + b"n")
    aged = time.time() - 86400 * 40
    for suffix in ("", ".json"):
        directory = restore.originals_dir(state_dir) if not suffix else restore.mappings_dir(state_dir)
        os.utime(Path(directory, f"{old_id}{suffix}"), (aged, aged))
    Path(restore.mappings_dir(state_dir), f"{old_id}.json").write_text(
        json.dumps({**json.loads(Path(restore.mappings_dir(state_dir), f"{old_id}.json").read_text()),
                    "kept_at_ns": str(int(aged * 1_000_000_000))})
    )

    index = restore.OriginalsIndex()
    removed, reclaimed = restore.prune_originals(db_conn, state_dir, index, 30, lambda _msg: None)
    assert (removed, reclaimed) == (1, len(ORIGINAL_BODY))
    assert [entry.id for entry in restore.scan_originals(state_dir)] == [new_id]


def test_prune_keeps_everything_while_retention_is_off(db_conn: psycopg.Connection, root_dir: Path, state_dir: str) -> None:
    _keep(state_dir, root_dir, "docs/scan.pdf")
    aged = time.time() - 86400 * 4000
    os.utime(Path(restore.mappings_dir(state_dir), f"{_sole_original(state_dir).id}.json"), (aged, aged))

    assert restore.prune_originals(db_conn, state_dir, restore.OriginalsIndex(), 0, lambda _msg: None) == (0, 0)
    assert len(restore.scan_originals(state_dir)) == 1


def test_a_pass_prunes_aged_originals(
    db_conn: psycopg.Connection, root_dir: Path, state_dir: str, target: RootTarget
) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    sidecar = Path(restore.mappings_dir(state_dir), f"{original_id}.json")
    document = json.loads(sidecar.read_text())
    aged_ns = int((time.time() - 86400 * 90) * 1_000_000_000)
    sidecar.write_text(json.dumps({**document, "kept_at_ns": str(aged_ns)}))

    logs: list[str] = []
    removed, _reclaimed = restore.prune_originals(
        db_conn, state_dir, restore.OriginalsIndex(), 30, logs.append, now=time.time
    )
    assert removed == 1
    assert any("pruned 1 kept original" in line for line in logs)


def test_write_mapping_can_date_a_backfilled_sidecar(state_dir: str) -> None:
    mapping = Mapping(
        root="sftpgo", path="docs/a.pdf", size=3, mtime_ns=7, original="abc_a.pdf", sha256=None,
        legacy=True, kept_at_ns=None,
    )
    stamp = time.time() - 7200
    restore.write_mapping(state_dir, mapping, kept_at=stamp)
    path = Path(restore.mappings_dir(state_dir), "abc_a.pdf.json")
    assert json.loads(path.read_text()) == mapping_document(mapping)
    assert path.stat().st_mtime == pytest.approx(stamp, abs=1)


def test_open_original_reports_the_kept_bytes(root_dir: Path, state_dir: str) -> None:
    original_id = _keep(state_dir, root_dir, "docs/scan.pdf")
    found = restore.open_original(state_dir, original_id)
    assert found is not None
    assert found[1] == len(ORIGINAL_BODY)
    assert restore.open_original(state_dir, "missing.pdf") is None
    assert restore.open_original(state_dir, "../escape") is None
