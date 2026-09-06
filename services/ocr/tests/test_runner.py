from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from fdrive_ocr import db, runner
from fdrive_ocr.decide import STATUS_TIMEOUT
from fdrive_ocr.settings import Settings

DEFAULT_SETTINGS = Settings(
    hour=3, langs="swe+eng", exclude_globs=("Programs/**", "Photos/**", "Videos/**"), max_mb=200, keep_originals=True
)


def _write_pdf(path: Path, marker: str) -> None:
    path.write_bytes(f"{marker}\n".encode())


# -- iter_candidate_pdfs -------------------------------------------------------


def test_iter_candidate_pdfs_finds_pdfs_and_skips_others(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_text("x")
    (tmp_path / "b.txt").write_text("x")
    (tmp_path / "._c.pdf").write_text("x")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "d.pdf").write_text("x")

    found = sorted(os.path.relpath(p, tmp_path) for p in runner.iter_candidate_pdfs(str(tmp_path)))
    assert found == ["a.pdf", os.path.join("sub", "d.pdf")]


def test_iter_candidate_pdfs_skips_configured_dirs(tmp_path: Path) -> None:
    skip = tmp_path / ".git"
    skip.mkdir()
    (skip / "hidden.pdf").write_text("x")
    (tmp_path / "visible.pdf").write_text("x")

    found = list(runner.iter_candidate_pdfs(str(tmp_path)))
    assert len(found) == 1
    assert found[0].endswith("visible.pdf")


# -- originals_dest / originals_stats ------------------------------------------


def test_originals_dest_is_stable_for_same_key(tmp_path: Path) -> None:
    a = runner.originals_dest(str(tmp_path), "sftpgo", "docs/a.pdf", 100, 111)
    b = runner.originals_dest(str(tmp_path), "sftpgo", "docs/a.pdf", 100, 111)
    assert a == b
    assert a.endswith("_a.pdf")


def test_originals_dest_differs_for_different_keys(tmp_path: Path) -> None:
    a = runner.originals_dest(str(tmp_path), "sftpgo", "docs/a.pdf", 100, 111)
    b = runner.originals_dest(str(tmp_path), "sftpgo", "docs/a.pdf", 100, 222)
    assert a != b


def test_originals_stats_empty_when_missing_dir(tmp_path: Path) -> None:
    assert runner.originals_stats(str(tmp_path / "nope")) == (0, 0)


def test_originals_stats_counts_files(tmp_path: Path) -> None:
    originals = tmp_path / "originals"
    originals.mkdir()
    (originals / "a").write_bytes(b"1234")
    (originals / "b").write_bytes(b"12")
    sub = originals / "sub"
    sub.mkdir()
    (sub / "c").write_bytes(b"999")  # not counted: scandir is not recursive

    count, total = runner.originals_stats(str(tmp_path))
    assert count == 2
    assert total == 6


# -- run_ocrmypdf ---------------------------------------------------------------


def test_run_ocrmypdf_success(tmp_path: Path) -> None:
    src = tmp_path / "in.pdf"
    dst = tmp_path / "out.pdf"
    _write_pdf(src, "OK")
    exit_code, stderr, timed_out = runner.run_ocrmypdf(str(src), str(dst), "swe+eng", 200, 30, 2)
    assert exit_code == 0
    assert timed_out is False
    assert dst.exists()


def test_run_ocrmypdf_has_text(tmp_path: Path) -> None:
    src = tmp_path / "in.pdf"
    dst = tmp_path / "out.pdf"
    _write_pdf(src, "HASTEXT")
    exit_code, _stderr, timed_out = runner.run_ocrmypdf(str(src), str(dst), "swe+eng", 200, 30, 2)
    assert exit_code == 6
    assert timed_out is False


def test_run_ocrmypdf_timeout() -> None:
    import subprocess

    def fake_run(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="ocrmypdf", timeout=1, output=None, stderr=b"partial output")

    exit_code, stderr, timed_out = runner.run_ocrmypdf("/in.pdf", "/out.pdf", "eng", 200, 1, 2, run=fake_run)
    assert timed_out is True
    assert exit_code == -1
    assert stderr == "partial output"


def test_run_ocrmypdf_timeout_with_no_stderr_captured() -> None:
    import subprocess

    def fake_run(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="ocrmypdf", timeout=1)

    _exit_code, stderr, timed_out = runner.run_ocrmypdf("/in.pdf", "/out.pdf", "eng", 200, 1, 2, run=fake_run)
    assert timed_out is True
    assert stderr == ""


# -- apply_rewrite ---------------------------------------------------------------


def test_apply_rewrite_preserves_mode_and_mtime_and_keeps_original(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"original bytes")
    os.chmod(src, 0o640)
    os.utime(src, (1_700_000_000, 1_700_000_000))
    st_before = os.stat(src)

    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten bytes")

    runner.apply_rewrite(
        str(src), str(tmp_out), str(state_dir), "sftpgo", "a.pdf", st_before.st_size, st_before.st_mtime_ns, True
    )

    assert src.read_bytes() == b"rewritten bytes"
    new_st = os.stat(src)
    assert stat.S_IMODE(new_st.st_mode) == 0o640
    assert new_st.st_mtime_ns == st_before.st_mtime_ns
    originals = list((state_dir / "originals").iterdir())
    assert len(originals) == 1
    assert originals[0].read_bytes() == b"original bytes"


def test_apply_rewrite_without_keep_originals_does_not_copy(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"original bytes")
    st_before = os.stat(src)
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten bytes")

    runner.apply_rewrite(
        str(src), str(tmp_out), str(state_dir), "sftpgo", "a.pdf", st_before.st_size, st_before.st_mtime_ns, False
    )

    assert not (state_dir / "originals").exists()


def test_apply_rewrite_does_not_recopy_existing_original(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"v1")
    st_before = os.stat(src)
    dest = runner.originals_dest(str(state_dir), "sftpgo", "a.pdf", st_before.st_size, st_before.st_mtime_ns)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    Path(dest).write_bytes(b"already-there")

    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten")
    runner.apply_rewrite(
        str(src), str(tmp_out), str(state_dir), "sftpgo", "a.pdf", st_before.st_size, st_before.st_mtime_ns, True
    )

    assert Path(dest).read_bytes() == b"already-there"


def test_apply_rewrite_tolerates_chown_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    src = root_dir / "a.pdf"
    src.write_bytes(b"v1")
    st_before = os.stat(src)
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"v2")

    def fake_chown(*args: object, **kwargs: object) -> None:
        raise PermissionError("not root")

    monkeypatch.setattr(os, "chown", fake_chown)
    runner.apply_rewrite(
        str(src), str(tmp_out), str(tmp_path / "state"), "sftpgo", "a.pdf", st_before.st_size, st_before.st_mtime_ns, False
    )
    assert src.read_bytes() == b"v2"


# -- process_file ----------------------------------------------------------------


def test_process_file_skips_already_done(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        _write_pdf(f, "OK")
        st = os.stat(f)
        done = {("a.pdf", st.st_size, st.st_mtime_ns)}
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, done, logs.append
        )
        assert status == "skipped_done"
        assert rewrite is False
    finally:
        conn.close()


def test_process_file_excluded(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        (tmp_path / "Photos").mkdir()
        f = tmp_path / "Photos" / "a.pdf"
        _write_pdf(f, "OK")
        settings = Settings(hour=3, langs="eng", exclude_globs=("sftpgo/Photos/**",), max_mb=200, keep_originals=True)
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), settings, str(tmp_path / "state"), 30, 2, set(), logs.append
        )
        assert status == "excluded"
        assert rewrite is False
        st = os.stat(f)
        assert db.done_keys(conn, root_id) == {("Photos/a.pdf", st.st_size, st.st_mtime_ns)}
    finally:
        conn.close()


def test_process_file_too_big(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        f.write_bytes(b"x" * 10)
        settings = Settings(hour=3, langs="eng", exclude_globs=(), max_mb=0, keep_originals=True)
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), settings, str(tmp_path / "state"), 30, 2, set(), logs.append
        )
        assert status == "too_big"
        assert rewrite is False
    finally:
        conn.close()


def test_process_file_ocred_rewrites_and_logs(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        _write_pdf(f, "OK")
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, set(), logs.append
        )
        assert status == "ocred"
        assert rewrite is True
        assert f.read_bytes() == b"OK-OCRED-OUTPUT\n"
        assert any("OCR'd" in line for line in logs)
        new_st = os.stat(f)
        assert db.done_keys(conn, root_id) == {("a.pdf", new_st.st_size, new_st.st_mtime_ns)}
    finally:
        conn.close()


def test_process_file_has_text_leaves_file_untouched(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        _write_pdf(f, "HASTEXT")
        original_bytes = f.read_bytes()
        status, rewrite = runner.process_file(
            conn, target, str(f), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, set(), lambda _m: None
        )
        assert status == "has_text"
        assert rewrite is False
        assert f.read_bytes() == original_bytes
    finally:
        conn.close()


def test_process_file_signed_and_encrypted(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        signed = tmp_path / "signed.pdf"
        _write_pdf(signed, "SIGNED")
        encrypted = tmp_path / "encrypted.pdf"
        _write_pdf(encrypted, "ENCRYPTED")

        status1, _ = runner.process_file(
            conn, target, str(signed), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, set(), lambda _m: None
        )
        status2, _ = runner.process_file(
            conn, target, str(encrypted), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, set(), lambda _m: None
        )
        assert status1 == "signed"
        assert status2 == "encrypted"
    finally:
        conn.close()


def test_process_file_failed_logs_detail(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        _write_pdf(f, "FAIL")
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, set(), logs.append
        )
        assert status == "failed"
        assert rewrite is False
        assert any("failed" in line for line in logs)
    finally:
        conn.close()


def test_process_file_timeout(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_id = db.upsert_root(conn, "sftpgo")
        target = runner.RootTarget(name="sftpgo", root_id=root_id, abs_path=str(tmp_path))
        f = tmp_path / "a.pdf"
        _write_pdf(f, "HANG")
        logs: list[str] = []
        status, rewrite = runner.process_file(
            conn, target, str(f), DEFAULT_SETTINGS, str(tmp_path / "state"), 1, 2, set(), logs.append
        )
        assert status == STATUS_TIMEOUT
        assert rewrite is False
    finally:
        conn.close()


# -- run_pass ----------------------------------------------------------------------


def test_run_pass_over_multiple_roots(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root_a = tmp_path / "a"
        root_a.mkdir()
        root_b = tmp_path / "b"
        root_b.mkdir()
        _write_pdf(root_a / "ok.pdf", "OK")
        _write_pdf(root_a / "has_text.pdf", "HASTEXT")
        _write_pdf(root_b / "fail.pdf", "FAIL")

        targets = [
            runner.RootTarget(name="a", root_id=db.upsert_root(conn, "a"), abs_path=str(root_a)),
            runner.RootTarget(name="b", root_id=db.upsert_root(conn, "b"), abs_path=str(root_b)),
        ]
        logs: list[str] = []
        totals = runner.run_pass(conn, targets, DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, logs.append)

        assert totals.seen == 3
        assert totals.ocred == 1
        assert totals.skipped == 1
        assert totals.failed == 1
        assert any("OCR pass start" in line for line in logs)
        assert any("OCR pass done" in line for line in logs)

        last = db.last_run(conn)
        assert last is not None
        assert last.seen == 3
        assert last.finished_at is not None
    finally:
        conn.close()


def test_run_pass_second_run_skips_already_done_files(postgres_dsn: str, tmp_path: Path) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root = tmp_path / "root"
        root.mkdir()
        _write_pdf(root / "has_text.pdf", "HASTEXT")
        target = runner.RootTarget(name="sftpgo", root_id=db.upsert_root(conn, "sftpgo"), abs_path=str(root))

        first = runner.run_pass(conn, [target], DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, lambda _m: None)
        assert first.seen == 1
        assert first.skipped == 1

        second = runner.run_pass(conn, [target], DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, lambda _m: None)
        assert second.seen == 1
        assert second.skipped == 0
        assert second.ocred == 0
        assert second.failed == 0
    finally:
        conn.close()


def test_run_pass_finishes_run_row_even_on_crash(postgres_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    conn = db.connect(postgres_dsn)
    try:
        root = tmp_path / "root"
        root.mkdir()
        _write_pdf(root / "ok.pdf", "OK")
        target = runner.RootTarget(name="sftpgo", root_id=db.upsert_root(conn, "sftpgo"), abs_path=str(root))

        def boom(*args: object, **kwargs: object) -> None:
            raise RuntimeError("kaboom")

        monkeypatch.setattr(runner, "process_file", boom)
        with pytest.raises(RuntimeError):
            runner.run_pass(conn, [target], DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, lambda _m: None)

        last = db.last_run(conn)
        assert last is not None
        assert last.finished_at is not None
    finally:
        conn.close()
